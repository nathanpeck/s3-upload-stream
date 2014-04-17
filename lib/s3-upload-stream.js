var Writable = require('stream').Writable,
    AWS      = require('aws-sdk');

module.exports = {
  // Generate a writeable stream which uploads to a file on S3.
  Uploader: function (connection, destinationDetails, doneCreatingUploadStream) {
    var self = this;

    if (arguments.length == 2)
    {
      // No connection passed in, assume that the connection details were already specified using
      // environment variables as documented at http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html
      doneCreatingUploadStream = destinationDetails;
      destinationDetails = connection;
      self.s3Client = new AWS.S3();
    }
    else
    {
      // The user already configured an S3 client that they want the stream to use.
      if (typeof connection.s3Client != 'undefined')
      {
        self.s3Client = connection.s3Client;
      }
      else
      {
        // The user hardcodes their credentials into their app
        self.s3Client = new AWS.S3({
          apiVersion: 'latest',
          accessKeyId: connection.accessKeyId,
          secretAccessKey: connection.secretAccessKey,
          region: connection.region
        });
      }
    }

    // Create the writeable stream interface.
    self.ws = Writable({
      highWaterMark: 4194304 // 4 MB
    });

    self.partNumber = 1;
    self.parts = [];
    self.receivedSize = 0;
    self.uploadedSize = 0;
    self.currentPart = Buffer(0);
    self.maxPartSize = 5242880;

    //Handler to receive data and upload it to S3.
    self.ws._write = function (Part, enc, next) {
      self.currentPart = Buffer.concat([self.currentPart, Part]);

      // If the current Part buffer is getting to large, or the stream piped in has ended then flush
      // the Part buffer downstream to S3 via the multipart upload API.
      if (self.currentPart.length > self.maxPartSize)
        self.flushPart(next);
      else
        next();
    };

    // Overwrite the end method so that we can hijack it to flush the last part and then complete
    // the multipart upload
    self.ws.originalEnd = self.ws.end;
    self.ws.end = function (Part, encoding, callback) {
      self.ws.originalEnd(Part, encoding, callback);
      self.flushPart();
    };

    self.flushPart = function (callback) {
      var uploadingPart = Buffer(self.currentPart.length);
      self.currentPart.copy(uploadingPart);

      var localPartNumber = self.partNumber;
      self.partNumber++;
      self.receivedSize += uploadingPart.length;
      self.s3Client.uploadPart(
        {
          Body: uploadingPart,
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: self.multipartUploadID,
          PartNumber: localPartNumber
        },
        function (err, result)
        {
          if (typeof callback == 'function')
            callback();

          if (err)
            self.ws.emit('error', err);
          else
          {
            self.uploadedSize += uploadingPart.length;
            self.parts[localPartNumber - 1] = {
              ETag: result.ETag,
              PartNumber: localPartNumber
            };

            self.ws.emit('chunk', {
              ETag: result.ETag,
              PartNumber: localPartNumber,
              receivedSize: self.receivedSize,
              uploadedSize: self.uploadedSize
            });

            // The incoming stream has finished giving us all data and we have finished uploading all that data to S3.
            // So tell S3 to assemble those parts we uploaded into the final product.
            if (self.ws._writableState.ended === true & self.uploadedSize == self.receivedSize)
            {
              self.s3Client.completeMultipartUpload(
                {
                  Bucket: destinationDetails.Bucket,
                  Key: destinationDetails.Key,
                  UploadId: self.multipartUploadID,
                  MultipartUpload: {
                    Parts: self.parts
                  }
                },
                function (err, result)
                {
                  if (err)
                    self.ws.emit('error', err);
                  else
                    self.ws.emit('uploaded', result);
                }
              );
            }
          }
        }
      );
      self.currentPart = Buffer(0);
    };

    // Use the S3 client to initialize a multipart upload to S3.
    this.s3Client.createMultipartUpload(
      destinationDetails,
      function (err, data)
      {
        if (err)
          doneCreatingUploadStream(err, data);
        else
        {
          self.multipartUploadID = data.UploadId;

          // Return the writeable stream for the client to pipe into.
          doneCreatingUploadStream(null, self.ws);
        }
      }
    );
  }
};
