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
    var self = this;
    var e = new events.EventEmitter();

    // Create the writeable stream interface.
    self.ws = new Writable({
      highWaterMark: 4194304 // 4 MB
    });

    // Data pertaining to the overall upload
    self.partNumber = 1;
    self.partIds = [];
    self.receivedSize = 0;
    self.uploadedSize = 0;

    // Parts which need to be uploaded to S3.
    self.pendingParts = 0;
    self.concurrentPartThreshold = 1;
    self.ready = false; // Initial ready state is false.

    // Data pertaining to buffers we have received
    self.receivedBuffers = [];
    self.receivedBuffersLength = 0;
    self.partSizeThreshold = 6242880;

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    self.ws.maxPartSize = function (partSize) {
      if (partSize < 5242880)
        partSize = 5242880;

      self.partSizeThreshold = partSize;
      return self.ws;
    };

    self.ws.getMaxPartSize = function () {
      return self.partSizeThreshold;
    };

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    self.ws.concurrentParts = function (parts) {
      if (parts < 1)
        parts = 1;

      self.concurrentPartThreshold = parts;
      return self.ws;
    };

    self.ws.getConcurrentParts = function () {
      return self.concurrentPartThreshold;
    };

    // Handler to receive data and upload it to S3.
    self.ws._write = function (incomingBuffer, enc, next) {
      self.absorbBuffer(incomingBuffer);

      if (self.receivedBuffersLength < self.partSizeThreshold)
        return next(); // Ready to receive more data in _write.

      // We need to upload some data
      self.uploadHandler(next);
    };

    // Concurrenly upload parts to S3.
    self.uploadHandler = function (next) {
      if (self.pendingParts < self.concurrentPartThreshold) {
        // We need to upload some of the data we've received
        if (self.ready)
          upload(); // Upload the part immeadiately.
        else
          e.once('ready', upload); // Wait until multipart upload is initialized.
      }
      else {
        // Block uploading (and receiving of more data) until we upload
        // some of the pending parts
        e.once('part', upload);
      }

      function upload() {
        self.pendingParts++;
        self.flushPart(function (partDetails) {
          --self.pendingParts;
          e.emit('part'); // Internal event
          self.ws.emit('part', partDetails); // External event
        });
        next();
      }
    };

    // Absorb an incoming buffer from _write into a buffer queue
    self.absorbBuffer = function (incomingBuffer) {
      self.receivedBuffers.push(incomingBuffer);
      self.receivedBuffersLength += incomingBuffer.length;
    };

    // Take a list of received buffers and return a combined buffer that is exactly
    // self.partSizeThreshold in size.
    self.preparePartBuffer = function () {
      // Combine the buffers we've received and reset the list of buffers.
      var combinedBuffer = Buffer.concat(self.receivedBuffers, self.receivedBufferLength);
      self.receivedBuffers.length = 0; // Trick to reset the array while keeping the original reference
      self.receivedBuffersLength = 0;

      if (combinedBuffer.length > self.partSizeThreshold) {
        // The combined buffer is too big, so slice off the end and put it back in the array.
        var remainder = new Buffer(combinedBuffer.length - self.partSizeThreshold);
        combinedBuffer.copy(remainder, 0, self.partSizeThreshold);
        self.receivedBuffers.push(remainder);
        self.receivedBuffersLength = remainder.length;

        // Return the original buffer.
        return combinedBuffer.slice(0, self.partSizeThreshold);
      }
      else {
        // It just happened to be perfectly sized, so return it.
        return combinedBuffer;
      }
    };

    // Flush a part out to S3.
    self.flushPart = function (callback) {
      var partBuffer = self.preparePartBuffer();

      var localPartNumber = self.partNumber;
      self.partNumber++;
      self.receivedSize += partBuffer.length;
      cachedClient.uploadPart(
        {
          Body: partBuffer,
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: self.multipartUploadID,
          PartNumber: localPartNumber
        },
        function (err, result) {
          if (err)
            self.abortUpload('Failed to upload a part to S3: ' + JSON.stringify(err));
          else {
            self.uploadedSize += partBuffer.length;
            self.partIds[localPartNumber - 1] = {
              ETag: result.ETag,
              PartNumber: localPartNumber
            };

            callback({
              ETag: result.ETag,
              PartNumber: localPartNumber,
              receivedSize: self.receivedSize,
              uploadedSize: self.uploadedSize
            });
          }
        }
      );
    };

    // Overwrite the end method so that we can hijack it to flush the last part and then complete
    // the multipart upload
    self.ws.originalEnd = self.ws.end;
    self.ws.end = function (Part, encoding, callback) {
      self.ws.originalEnd(Part, encoding, function afterDoneWithOriginalEnd() {
        if (Part)
          self.absorbBuffer(Part);

        // Upload any remaining data
        var uploadRemainingData = function () {
          if (self.receivedBuffersLength > 0) {
            self.uploadHandler(uploadRemainingData);
            return;
          }

          if (self.pendingParts > 0) {
            setTimeout(uploadRemainingData, 50); // Wait 50 ms for the pending uploads to finish before trying again.
            return;
          }

          self.completeUpload();
        };

        uploadRemainingData();

        if (typeof callback == 'function')
          callback();
      });
    };

    // Turn all the individual parts we uploaded to S3 into a finalized upload.
    self.completeUpload = function () {
      cachedClient.completeMultipartUpload(
        {
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: self.multipartUploadID,
          MultipartUpload: {
            Parts: self.partIds
          }
        },
        function (err, result) {
          if (err)
            self.abortUpload('Failed to complete the multipart upload on S3: ' + JSON.stringify(err));
          else {
            // Emit both events for backwards compatability, and to follow the spec.
            self.ws.emit('uploaded', result);
            self.ws.emit('finish', result);
          }
        }
      );
    };

    // When a fatal error occurs abort the multipart upload
    self.abortUpload = function (rootError) {
      cachedClient.abortMultipartUpload(
        {
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: self.multipartUploadID
        },
        function (abortError) {
          if (abortError)
            self.ws.emit('error', rootError + '\n Additionally failed to abort the multipart upload on S3: ' + abortError);
          else
            self.ws.emit('error', rootError);
        }
      );
    };

    if (!cachedClient) {
      throw new Error('Must configure an S3 client before attempting to create an S3 upload stream.');
    }
    else {
      // Ensure that the writable stream is returned before we actually attempt to create the MPU.
      setImmediate(function () {
        cachedClient.createMultipartUpload(
          destinationDetails,
          function (err, data) {
            if (err)
              self.ws.emit('error', 'Failed to create a multipart upload on S3: ' + JSON.stringify(err));
            else {
              self.multipartUploadID = data.UploadId;
              self.ready = true;
              self.ws.emit('ready');
              e.emit('ready'); // Internal event
            }
          }
        );
      });
    }

    return self.ws;
  }
};
