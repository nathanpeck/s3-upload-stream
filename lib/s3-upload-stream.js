var Writable = require('stream').Writable,
    events = require("events");

var cachedClient;

module.exports = {
  // Set the S3 client to be used for this upload.
  client: function (client) {
    cachedClient = client;
  },

  // Generate a writeable stream which uploads to a file on S3.
  upload: function (destinationDetails) {
    var e = new events.EventEmitter();

    // Create the writeable stream interface.
    var ws = new Writable({
      highWaterMark: 4194304 // 4 MB
    });

    // Data pertaining to the overall upload
    var multipartUploadID;
    var partNumber = 1;
    var partIds = [];
    var receivedSize = 0;
    var uploadedSize = 0;

    // Parts which need to be uploaded to S3.
    var pendingParts = 0;
    var concurrentPartThreshold = 1;

    // Data pertaining to buffers we have received
    var receivedBuffers = [];
    var receivedBuffersLength = 0;
    var partSizeThreshold = 5242880;

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    ws.maxPartSize = function (partSize) {
      if (partSize < 5242880)
        partSize = 5242880;

      partSizeThreshold = partSize;
      return ws;
    };

    ws.getMaxPartSize = function () {
      return partSizeThreshold;
    };

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    ws.concurrentParts = function (parts) {
      if (parts < 1)
        parts = 1;

      concurrentPartThreshold = parts;
      return ws;
    };

    ws.getConcurrentParts = function () {
      return concurrentPartThreshold;
    };

    // Handler to receive data and upload it to S3.
    ws._write = function (incomingBuffer, enc, next) {
      absorbBuffer(incomingBuffer);

      if (receivedBuffersLength < partSizeThreshold)
        return next(); // Ready to receive more data in _write.

      // We need to upload some data
      uploadHandler(next);
    };

    // Concurrently upload parts to S3.
    var uploadHandler = function (next) {
      if (pendingParts < concurrentPartThreshold) {
        // Has the MPU been created yet?
        if (multipartUploadID)
          upload(); // Upload the part immediately.
        else {
          e.once('ready', upload); // Wait until multipart upload is initialized.
          createMultipartUpload();
        }
      }
      else {
        // Block uploading (and receiving of more data) until we upload
        // some of the pending parts
        e.once('part', upload);
      }

      function upload() {
        pendingParts++;
        flushPart(function (partDetails) {
          --pendingParts;
          e.emit('part'); // Internal event
          ws.emit('part', partDetails); // External event
        });
        next();
      }
    };

    // Absorb an incoming buffer from _write into a buffer queue
    var absorbBuffer = function (incomingBuffer) {
      receivedBuffers.push(incomingBuffer);
      receivedBuffersLength += incomingBuffer.length;
    };

    // Take a list of received buffers and return a combined buffer that is exactly
    // partSizeThreshold in size.
    var preparePartBuffer = function () {
      // Combine the buffers we've received and reset the list of buffers.
      var combinedBuffer = Buffer.concat(receivedBuffers, receivedBuffersLength);
      receivedBuffers.length = 0; // Trick to reset the array while keeping the original reference
      receivedBuffersLength = 0;

      if (combinedBuffer.length > partSizeThreshold) {
        // The combined buffer is too big, so slice off the end and put it back in the array.
        var remainder = new Buffer(combinedBuffer.length - partSizeThreshold);
        combinedBuffer.copy(remainder, 0, partSizeThreshold);
        receivedBuffers.push(remainder);
        receivedBuffersLength = remainder.length;

        // Return the perfectly sized part.
        var uploadBuffer = new Buffer(partSizeThreshold);
        combinedBuffer.copy(uploadBuffer, 0, 0, partSizeThreshold);
        return uploadBuffer;
      }
      else {
        // It just happened to be perfectly sized, so return it.
        return combinedBuffer;
      }
    };

    // Flush a part out to S3.
    var flushPart = function (callback) {
      var partBuffer = preparePartBuffer();

      var localPartNumber = partNumber;
      partNumber++;
      receivedSize += partBuffer.length;
      cachedClient.uploadPart(
        {
          Body: partBuffer,
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: multipartUploadID,
          PartNumber: localPartNumber
        },
        function (err, result) {
          if (err)
            abortUpload('Failed to upload a part to S3: ' + JSON.stringify(err));
          else {
            uploadedSize += partBuffer.length;
            partIds[localPartNumber - 1] = {
              ETag: result.ETag,
              PartNumber: localPartNumber
            };

            callback({
              ETag: result.ETag,
              PartNumber: localPartNumber,
              receivedSize: receivedSize,
              uploadedSize: uploadedSize
            });
          }
        }
      );
    };

    // Overwrite the end method so that we can hijack it to flush the last part and then complete
    // the multipart upload
    ws.originalEnd = ws.end;
    ws.end = function (Part, encoding, callback) {
      ws.originalEnd(Part, encoding, function afterDoneWithOriginalEnd() {
        if (Part)
          absorbBuffer(Part);

        // Upload any remaining data
        var uploadRemainingData = function () {
          if (receivedBuffersLength > 0) {
            uploadHandler(uploadRemainingData);
            return;
          }

          if (pendingParts > 0) {
            setTimeout(uploadRemainingData, 50); // Wait 50 ms for the pending uploads to finish before trying again.
            return;
          }

          completeUpload();
        };

        uploadRemainingData();

        if (typeof callback == 'function')
          callback();
      });
    };

    // Turn all the individual parts we uploaded to S3 into a finalized upload.
    var completeUpload = function () {
      // There is a possibility that the incoming stream was empty, therefore the MPU never started
      // and cannot be finalized.
      if (multipartUploadID) {
        cachedClient.completeMultipartUpload(
          {
            Bucket: destinationDetails.Bucket,
            Key: destinationDetails.Key,
            UploadId: multipartUploadID,
            MultipartUpload: {
              Parts: partIds
            }
          },
          function (err, result) {
            if (err)
              abortUpload('Failed to complete the multipart upload on S3: ' + JSON.stringify(err));
            else {
              // Emit both events for backwards compatibility, and to follow the spec.
              ws.emit('uploaded', result);
              ws.emit('finish', result);
            }
          }
        );
      }
    };

    // When a fatal error occurs abort the multipart upload
    var abortUpload = function (rootError) {
      cachedClient.abortMultipartUpload(
        {
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: multipartUploadID
        },
        function (abortError) {
          if (abortError)
            ws.emit('error', rootError + '\n Additionally failed to abort the multipart upload on S3: ' + abortError);
          else
            ws.emit('error', rootError);
        }
      );
    };

    var createMultipartUpload = function () {
      cachedClient.createMultipartUpload(
        destinationDetails,
        function (err, data) {
          if (err)
            ws.emit('error', 'Failed to create a multipart upload on S3: ' + JSON.stringify(err));
          else {
            multipartUploadID = data.UploadId;
            ws.emit('ready');
            e.emit('ready'); // Internal event
          }
        }
      );
    };

    if (!cachedClient) {
      throw new Error('Must configure an S3 client before attempting to create an S3 upload stream.');
    }

    return ws;
  }
};
