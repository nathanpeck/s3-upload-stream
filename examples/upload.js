#!/usr/bin/env node

var Uploader = require('../lib/s3-upload-stream.js').Uploader,
    zlib     = require('zlib'),
    fs       = require('fs');

var read = fs.createReadStream('./path/to/file.ext');
var compress = zlib.createGzip();

var UploadStreamObject = new Uploader(
  // Connection details. (Optional if your credentials are specified
  // via environment variables or AMI role.)
  {
    "accessKeyId": "REDACTED",
    "secretAccessKey": "REDACTED",
    "region": "us-east-1"
  },
  // Upload destination details.
  // For a full list of possible parameters see:
  // http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#createMultipartUpload-property
  {
    "Bucket": "your-bucket-name",
    "Key": "uploaded-file-name " + new Date()
  },
  function (err, uploadStream)
  {
    if (err)
      console.log(err, uploadStream);
    else
    {
      // This event is emitted when a single part of the stream is uploaded.
      uploadStream.on('chunk', function (data) {
        console.log(data);
      });

      // Emitted when all parts have been flushed to S3 and the multipart
      // upload has been finalized.
      uploadStream.on('uploaded', function (data) {
        console.log(data);
      });

      // Pipe the file stream through Gzip compression and upload result to S3.
      read.pipe(compress).pipe(uploadStream);
    }
  }
);
