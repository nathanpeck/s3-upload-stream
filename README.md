## s3-upload-stream [![Build Status](https://travis-ci.org/nathanpeck/s3-upload-stream.svg)](https://travis-ci.org/nathanpeck/s3-upload-stream)

A pipeable write stream which uploads to Amazon S3 using the multipart file upload API.

[![NPM](https://nodei.co/npm/s3-upload-stream.png?downloads=true)](https://www.npmjs.org/package/s3-upload-stream)

### Changelog

#### 0.6.2 (2014-08-31)

Upgrading the AWS SDK dependency to the latest version. Fixes issue #11

#### 0.6.1 (2014-08-15)

Fix for an issue with the internal event emitter being improperly attached. This issue caused crashes in v0.5.0 and v0.6.0, so it is recommended that you upgrade to v0.6.1 if you are using one of the affected versions.

[Historical Changelogs](CHANGELOG.md)

### Why use this stream?

* This upload stream does not require you to know the length of your content prior to beginning uploading. Many other popular S3 wrappers such as [Knox](https://github.com/LearnBoost/knox) also allow you to upload streams to S3, but they require you to specify the content length. This is not always feasible.
* By piping content to S3 via the multipart file upload API you can keep memory usage low even when operating on a stream that is GB in size. Many other libraries actually store the entire stream in memory and then upload it in one piece. This stream avoids high memory usage by flushing the stream to S3 in 5 MB parts such that it should only ever store 5 MB of the stream data at a time.
* This package utilizes the official Amazon SDK for Node.js, helping keep it small and efficient.
* You can provide options for the upload call directly to do things like set server side encryption, reduced redundancy storage, or access level on the object, which some other similar streams are lacking.
* Emits "chunk" events which expose the amount of incoming data received by the writable stream versus the amount of data that has been uploaded via the multipart API so far, allowing you to create a progress bar if that is a requirement.

### Limits

* The multipart upload API does not accept chunks less than 5 MB in size. So although this stream emits "chunk" events which can be used to show progress, the progress is not very granular, as the events are only per part. By default this means that you will receive an event each 5 MB.
* The Amazon SDK has a limit of 10,000 parts when doing a mulitpart upload. Since the part size is currently set to 5 MB this means that your stream will fail to upload if it contains more than 50 GB of data. This can be solved by using the 'stream.maxPartSize()' method of the writable stream to set the max size of an upload part, as documented below. By increasing this value you should be able to save streams that are many TB in size.

## Usage

### Uploader(destinationDetails, callback);

The recommended approach for credential management is to [set your AWS API keys using environment variables](http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html) or [AMI roles](http://docs.aws.amazon.com/IAM/latest/UserGuide/WorkingWithRoles.html). If you are following these best practices for separating your credentials from your code then there is no need to specify connection details when creating an upload stream.

The `destinationDetails` parameter takes the following form:

__Required Properties__

* `Bucket` - The name of the bucket that you want the stream to save to
* `Key` - The name of the "file" on S3 that the stream will save into

__Optional Parameters__

You can specify many other optional parameters to for content type, ACL (access control), expiration, metadata, server side encryption, and storage class for reduce redundancy. The AWS SDK documentation contains a [full list of these parameters](http://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#createMultipartUpload-property).

### Uploader(connectionDetails, destinationDetails, callback);

If you want to manage the connection used by the upload stream yourself you can specify the connection details directly in one of two forms:

__Directly Specify a Client__

If you want to reuse a client that you have created elsewhere in your code you can pass it in as a property of `connectionDetails`:

```js
{
  s3Client: yourS3ClientHere,
}
```

__Specify Credentials__

If you would like the upload stream to create its own client then you can pass in credentials directly:

```js
{
  accessKeyId: "REDACTED",
  secretAccessKey: "REDACTED",
  region: "us-east-1"
}
```

### Example

```js
var Uploader = require('s3-upload-stream').Uploader,
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
    if(err)
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
```

## Optional Configuration

### stream.maxPartSize(sizeInBytes)

Used to adjust the maximum amount of stream data that will be buffered in memory prior to flushing. The lowest possible value, and default value, is 5 MB. It is not possible to set this value any lower than 5 MB due to Amazon S3 restrictions, but there is no hard upper limit. The higher the value you choose the more stream data will be buffered in memory before flushing to S3.

The main reason for setting this to a higher value instead of using the default is if you have a stream with more than 50 GB of data, and therefore need larger part sizes in order to flush the entire stream while also staying within Amazon's upper limit of 10,000 parts for the multipart upload API.

```js
var UploadStreamObject = new Uploader(
  {
    "Bucket": "your-bucket-name",
    "Key": "uploaded-file-name " + new Date()
  },
  function (err, uploadStream)
  {
    uploadStream.on('uploaded', function (data) {
      console.log('done');
    });

    read.pipe(uploadStream);
  }
).maxPartSize(20971520) //20 MB;
```

### stream.concurrentParts(numberOfParts)

Used to adjust the number of parts that are concurrently uploaded to S3. By default this is just one at a time, to keep memory usage low and allow the upstream to deal with backpressure. However, in some cases you may wish to drain the stream that you are piping in quickly, and then issue concurrent upload requests to upload multiple parts.

Keep in mind that total memory usage will be at least `maxPartSize` * `concurrentParts` as each concurrent part will be `maxPartSize` large, so it is not recommended that you set both `maxPartSize` and `concurrentParts` to high values, or your process will be buffering large amounts of data in its memory.

```js
var UploadStreamObject = new Uploader(
  {
    "Bucket": "your-bucket-name",
    "Key": "uploaded-file-name " + new Date()
  },
  function (err, uploadStream)
  {
    uploadStream.on('uploaded', function (data) {
      console.log('done');
    });

    read.pipe(uploadStream);
  }
).concurrentParts(5);
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
