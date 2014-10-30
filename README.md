## s3-upload-stream [![Build Status](https://travis-ci.org/nathanpeck/s3-upload-stream.svg)](https://travis-ci.org/nathanpeck/s3-upload-stream)

A pipeable write stream which uploads to Amazon S3 using the multipart file upload API.

[![NPM](https://nodei.co/npm/s3-upload-stream.png?downloads=true)](https://www.npmjs.org/package/s3-upload-stream)

### Changelog

#### 1.0.6 (2014-10-20)

Removing global state, and adding pause and resume functionality.

[Historical Changelogs](CHANGELOG.md)

### Why use this stream?

* This upload stream does not require you to know the length of your content prior to beginning uploading. Many other popular S3 wrappers such as [Knox](https://github.com/LearnBoost/knox) also allow you to upload streams to S3, but they require you to specify the content length. This is not always feasible.
* By piping content to S3 via the multipart file upload API you can keep memory usage low even when operating on a stream that is GB in size. Many other libraries actually store the entire stream in memory and then upload it in one piece. This stream avoids high memory usage by flushing the stream to S3 in 5 MB parts such that it should only ever store 5 MB of the stream data at a time.
* This package is designed to use the official Amazon SDK for Node.js, helping keep it small and efficient. For maximum flexibility you pass in the aws-sdk client yourself, allowing you to use a uniform version of AWS SDK throughout your code base.
* You can provide options for the upload call directly to do things like set server side encryption, reduced redundancy storage, or access level on the object, which some other similar streams are lacking.
* Emits "part" events which expose the amount of incoming data received by the writable stream versus the amount of data that has been uploaded via the multipart API so far, allowing you to create a progress bar if that is a requirement.
* Support for pausing and later resuming in progress multipart uploads.

### Limits

* The multipart upload API does not accept parts less than 5 MB in size. So although this stream emits "part" events which can be used to show progress, the progress is not very granular, as the events are only per part. By default this means that you will receive an event each 5 MB.
* The Amazon SDK has a limit of 10,000 parts when doing a mulitpart upload. Since the part size is currently set to 5 MB this means that your stream will fail to upload if it contains more than 50 GB of data. This can be solved by using the 'stream.maxPartSize()' method of the writable stream to set the max size of an upload part, as documented below. By increasing this value you should be able to save streams that are many TB in size.

## Example

```js
var AWS      = require('aws-sdk'),
    zlib     = require('zlib'),
    fs       = require('fs');
    s3Stream = require('s3-upload-stream')(new AWS.S3()),

// Set the client to be used for the upload.
AWS.config.loadFromPath('./config.json');

// Create the streams
var read = fs.createReadStream('/path/to/a/file');
var compress = zlib.createGzip();
var upload = s3Stream.upload({
  "Bucket": "bucket-name",
  "Key": "key-name"
});

// Optional configuration
upload.maxPartSize(20971520); // 20 MB
upload.concurrentParts(5);

// Handle errors.
upload.on('error', function (error) {
  console.log(error);
});

/* Handle progress. Example details object:
   { ETag: '"f9ef956c83756a80ad62f54ae5e7d34b"',
     PartNumber: 5,
     receivedSize: 29671068,
     uploadedSize: 29671068 }
*/
upload.on('part', function (details) {
  console.log(details);
});

/* Handle upload completion. Example details object:
   { Location: 'https://bucketName.s3.amazonaws.com/filename.ext',
     Bucket: 'bucketName',
     Key: 'filename.ext',
     ETag: '"bf2acbedf84207d696c8da7dbb205b9f-5"' }
*/
upload.on('uploaded', function (details) {
  console.log(details);
});

// Pipe the incoming filestream through compression, and up to S3.
read.pipe(compress).pipe(upload);
```

## Usage

Before uploading you must configure the S3 client for s3-upload-stream to use. Please note that this module has only been tested with AWS SDK 2.0 and greater.

This module does not include the AWS SDK itself. Rather you must require the AWS SDK in your own application code, instantiate an S3 client and then supply it to s3-upload-stream.

The main advantage of this is that rather than being stuck with a set version of the AWS SDK that ships with s3-upload-stream you can ensure that s3-upload-stream is using whichever verison of the SDK you want.

When setting up the S3 client the recommended approach for credential management is to [set your AWS API keys using environment variables](http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html) or [AMI roles](http://docs.aws.amazon.com/IAM/latest/UserGuide/WorkingWithRoles.html).

If you are following this approach then you can configure the S3 client very simply:

```js
var AWS      = require('aws-sdk'),
    s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());
```

However, some environments may require you to keep your credentials in a file, or hardcoded. In that case you can use the following form:

```js
var AWS      = require('aws-sdk');

// Make sure AWS credentials are loaded using one of the following techniques
AWS.config.loadFromPath('./config.json');
AWS.config.update({accessKeyId: 'akid', secretAccessKey: 'secret'});

// Create a stream client.
var s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());
```

### client.upload(destination)

Create an upload stream that will upload to the specified destination. The upload stream is returned immeadiately.

The destination details is an object in which you can specify many different [destination properties enumerated in the AWS S3 documentation](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#createMultipartUpload-property).

__Example:__

```js
var AWS      = require('aws-sdk'),
    s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());

var read = fs.createReadStream('/path/to/a/file');
var upload = s3Stream.upload({
  Bucket: "bucket-name",
  Key: "key-name",
  ACL: "public-read",
  StorageClass: "REDUCED_REDUNDANCY",
  ContentType: "binary/octet-stream"
});

read.pipe(upload);
```

### client.upload(destination, [session])

Resume an incomplete multipart upload from a previous session by providing a `session` object with an upload ID, and ETag and numbers for each part. `destination` details is as above.

__Example:__

```js
var AWS      = require('aws-sdk'),
    s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());

var read = fs.createReadStream('/path/to/a/file');
var upload = s3Stream.upload(
  {
    Bucket: "bucket-name",
    Key: "key-name",
    ACL: "public-read",
    StorageClass: "REDUCED_REDUNDANCY",
    ContentType: "binary/octet-stream"
  },
  {
    UploadId: "f1j2b47238f12984f71b2o8347f12",
    Parts: [
      {
        ETag: "3k2j3h45t9v8aydgajsda",
        PartNumber: 1
      },
      {
        Etag: "kjgsdfg876sd8fgk3j44t",
        PartNumber: 2
      }
    ]
  }
);

read.pipe(upload);
```

## Stream Methods

The following methods can be called on the stream returned by from `client.upload()`

### stream.pause()

Pause an active multipart upload stream.

Calling `pause()` will immediately:

* stop accepting data from an input stream,
* stop submitting new parts for upload, and
* emit a `pausing` event with the number of parts that are still mid-upload.

When mid-upload parts are finished, a `paused` event will fire, including an object with `UploadId` and `Parts` data that can be used to resume an upload in a later session.

### stream.resume()

Resume a paused multipart upload stream.

Calling `resume()` will immediately:

* resume accepting data from an input stream,
* resume submitting new parts for upload, and
* echo a `resume` event back to any listeners.

It is safe to call `resume()` at any time after `pause()`. If the stream is between `pausing` and `paused`, then `resume()` will resume data flow and the `paused` event will not be fired.

### stream.maxPartSize(sizeInBytes)

Used to adjust the maximum amount of stream data that will be buffered in memory prior to flushing. The lowest possible value, and default value, is 5 MB. It is not possible to set this value any lower than 5 MB due to Amazon S3 restrictions, but there is no hard upper limit. The higher the value you choose the more stream data will be buffered in memory before flushing to S3.

The main reason for setting this to a higher value instead of using the default is if you have a stream with more than 50 GB of data, and therefore need larger part sizes in order to flush the entire stream while also staying within Amazon's upper limit of 10,000 parts for the multipart upload API.

```js
var AWS      = require('aws-sdk'),
    s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());

var read = fs.createReadStream('/path/to/a/file');
var upload = s3Stream.upload({
  "Bucket": "bucket-name",
  "Key": "key-name"
});

upload.maxPartSize(20971520); // 20 MB

read.pipe(upload);
```

### stream.concurrentParts(numberOfParts)

Used to adjust the number of parts that are concurrently uploaded to S3. By default this is just one at a time, to keep memory usage low and allow the upstream to deal with backpressure. However, in some cases you may wish to drain the stream that you are piping in quickly, and then issue concurrent upload requests to upload multiple parts.

Keep in mind that total memory usage will be at least `maxPartSize` * `concurrentParts` as each concurrent part will be `maxPartSize` large, so it is not recommended that you set both `maxPartSize` and `concurrentParts` to high values, or your process will be buffering large amounts of data in its memory.

```js
var AWS      = require('aws-sdk'),
    s3Stream = require('../lib/s3-upload-stream.js')(new AWS.S3());

var read = fs.createReadStream('/path/to/a/file');
var upload = s3Stream.upload({
  "Bucket": "bucket-name",
  "Key": "key-name"
});

upload.concurrentParts(5);

read.pipe(upload);
```

### Tuning configuration of the AWS SDK

The following configuration tuning can help prevent errors when using less reliable internet connections (such as 3G data if you are using Node.js on the Tessel) by causing the AWS SDK to detect upload timeouts and retry.

```js
var AWS = require('aws-sdk');
AWS.config.httpOptions = {timeout: 5000};
```

### Installation

```
npm install s3-upload-stream
```

### Running Tests

```
npm test
```

### License

(The MIT License)

Copyright (c) 2014 Nathan Peck <nathan@storydesk.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
