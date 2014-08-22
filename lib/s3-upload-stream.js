var Writable = require('stream').Writable,
    events = require("events"),
    AWS      = require('aws-sdk');

var cachedClient;

module.exports = {
  setClient: function (client) {
    cachedClient = client;
  },

  // Generate a writeable stream which uploads to a file on S3.
  Uploader: function (connection, destinationDetails, doneCreatingUploadStream) {
    var self = this;
    var e = new events.EventEmitter();

    if (arguments.length == 2) {
      // No connection passed in, assume that the connection details were already specified using
      // environment variables as documented at http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html
      doneCreatingUploadStream = destinationDetails;
      destinationDetails = connection;
      if (cachedClient)
        self.s3Client = cachedClient;
      else
        self.s3Client = new AWS.S3();
    }
    else {
      // The user already configured an S3 client that they want the stream to use.
      if (typeof connection.s3Client != 'undefined')
        self.s3Client = connection.s3Client;
      else if (connection.accessKeyId && connection.secretAccessKey) {
        // The user hardcodes their credentials into their app
        self.s3Client = new AWS.S3({
          apiVersion: 'latest',
          accessKeyId: connection.accessKeyId,
          secretAccessKey: connection.secretAccessKey,
          region: connection.region
        });
      }
      else if (cachedClient) {
        self.s3Client = cachedClient;
      }
      else {
        throw "Unable to find an interface for connecting to S3";
      }
    }

    // Create the writeable stream interface.
    self.ws = Writable({
      highWaterMark: 4194304 // 4 MB
    });

    events.EventEmitter.call(self);

    // Data pertaining to the overall upload
    self.partNumber = 1;
    self.partIds = [];
    self.receivedSize = 0;
    self.uploadedSize = 0;

    // Parts which need to be uploaded to S3.
    self.pendingParts = 0;
    self.concurrentPartThreshold = 1;

    // Data pertaining to buffers we have received
    self.receivedBuffers = [];
    self.receivedBuffersLength = 0;
    self.partSizeThreshold = 6242880;

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    self.maxPartSize = function (partSize) {
      if (partSize < 5242880)
        partSize = 5242880;

      self.partSizeThreshold = partSize;
      return self;
    };

    // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
    // of the multipart upload
    self.concurrentParts = function (parts) {
      if (parts < 1)
        parts = 1;

      self.concurrentPartThreshold = parts;
      return self;
    };

    // Handler to receive data and upload it to S3.
    self.ws._write = function (incomingBuffer, enc, next) {
      self.absorbBuffer(incomingBuffer);

      if (self.receivedBuffersLength < self.partSizeThreshold)
        return next(); // Ready to receive more data in _write.

      // We need to upload some data
      self.uploadHandler(next);
    };

    self.uploadHandler = function (next) {
      if (self.pendingParts < self.concurrentPartThreshold) {
        // We need to upload some of the data we've received
        upload();
      }
      else {
        // Block uploading (and receiving of more data) until we upload
        // some of the pending parts
        e.once('chunk', upload);
      }

      function upload() {
        self.pendingParts++;
        self.flushPart(function (partDetails) {
          --self.pendingParts;
          e.emit('chunk'); // Internal event
          self.ws.emit('chunk', partDetails); // External event
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
      self.s3Client.uploadPart(
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
      self.s3Client.completeMultipartUpload(
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
          else
            self.ws.emit('uploaded', result);
        }
      );
    };

    // When a fatal error occurs abort the multipart upload
    self.abortUpload = function (rootError) {
      self.s3Client.abortMultipartUpload(
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

    // Use the S3 client to initialize a multipart upload to S3.
    this.s3Client.createMultipartUpload(
      destinationDetails,
      function (err, data) {
        if (err)
          doneCreatingUploadStream('Failed to create a multipart upload on S3: ' + JSON.stringify(err));
        else {
          self.multipartUploadID = data.UploadId;

          // Return the writeable stream for the client to pipe into.
          doneCreatingUploadStream(null, self.ws);
        }
      }
    );
  }
};
