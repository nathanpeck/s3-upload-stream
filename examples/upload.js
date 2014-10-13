#!/usr/bin/env node
var s3Stream = require('../lib/s3-upload-stream.js'),
    AWS      = require('aws-sdk'),
    zlib     = require('zlib'),
    fs       = require('fs');

// JSON file containing AWS API credentials.
AWS.config.loadFromPath('./config.json');

// Set the client to be used for the upload.
s3Stream.client(new AWS.S3());

// Create the streams
var read = fs.createReadStream('path/to/file');
var compress = zlib.createGzip();
var upload = new s3Stream.upload({
  "Bucket": "bucket-name",
  "Key": "key-name"
});

// Handle errors.
upload.on('error', function (error) {
  console.log(error);
});

// Handle progress.
upload.on('part', function (details) {
  console.log(details);
});

// Handle upload completion.
upload.on('uploaded', function (details) {
  console.log(details);
});

// Pipe the incoming filestream through compression, and up to S3.
read.pipe(compress).pipe(upload);
