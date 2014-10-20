Changelog
=========

#### 1.0.6 (2014-10-20)

Removing global state, and adding pause and resume functionality.

#### 1.0.5 (2014-10-13)

Changing how buffers are subdivided, in order to provide support for in browser operation.

#### 1.0.4 (2014-10-13)

Getting rid of the use of setImmeadiate. Also now the MPU is not initialized until data is actually received by the writable stream, and error checking verifies that data has actually been uploaded to S3 before trying to end the stream. This fixes an issue where empty incoming streams were causing errors to come back from S3 as the module was attempting to complete an empty MPU.

#### 1.0.3 (2014-10-12)

Scope changes for certain use cases.

#### 1.0.2 (2014-09-26)

Now emits a "finish" event, as well as the "uploaded" event, in order to adhere to Node.js writable stream spec.

#### 1.0.1 (2014-09-26)

Fixed error in usage in the documentation and examples. The examples did not use the "new" keyword when creating the upload stream, so there were scope issues when doing parallel uploads. This has been clarified and corrected in the documentation and examples.

#### 1.0.0 (2014-09-15)

Major overhaul of the functional interface. Breaks compatability with older versions of the module in favor of a cleaner, more streamlined approach. A migration guide for users of older versions of the module has been included in the documentation.

#### 0.6.2 (2014-08-31)

Upgrading the AWS SDK dependency to the latest version. Fixes issue #11

#### 0.6.1 (2014-08-22)

* The internal event emitter wasn't set up properly, causing errors about the upload stream object not having the .emit and/or .once methods. This bug impacted versions 0.5.0 and 0.6.0. Fixes issue #10.

#### 0.6.0 (2014-08-15)

* Fix for mismatch between documentation and reality in the maxPartSize() and concurrentParts() options.
* New feature: part size and concurrect part helpers can be chained now.
* *Warning, this version has a critical bug. It is recommended that you use 0.6.1 instead*

### 0.5.0 (2014-08-11)

* Added client caching to reuse an existing s3 client rather than creating a new one for each upload. Fixes #6
* Updated the maxPartSize to be a hard limit instead of a soft one so that generated ETAG are consistent to to the reliable size of the uploaded parts. Fixes #7
* Added this file. Fixes #8
* New feature: concurrent part uploads. Now you can optionally enable concurrent part uploads if you wish to allow your application to drain the source stream more quickly and absorb some of the bottle neck when uploading to S3.
* *Warning, this version has a critical bug. It is recommended that you use 0.6.1 instead*

### 0.4.0 (2014-06-23)

* Now with better error handling. If an error occurs while uploading a part to S3, or completing a multipart upload then the in progress multipart upload will be aborted (to delete the uploaded parts from S3) and a more descriptive error message will be emitted instead of the raw error response from S3.

### 0.3.0 (2014-05-06)

* Added tests using a stubbed out version of the Amazon S3 client. These tests will ensure that the upload stream behaves properly, calls S3 correctly, and emits the proper events.
* Added Travis integration
* Also fixed bug with the functionality to dynamically adjust the part size.

### 0.2.0 (2014-04-25)

* Fixed a race condition bug that occured occasionally with streams very close to the 5 MB size threshold where the multipart upload would be finalized on S3 prior to the last data buffer being flushed, resulting in the last part of the stream being cut off in the resulting S3 file. (Notice: If you are using an older version of this module I highly recommend upgrading to get this latest bugfix.)
* Added a method for adjusting the part size dynamically.

### 0.1.0 (2014-04-17)

* Code cleanups and stylistic goodness.
* Made the connection parameters optional for those who are following Amazon's best practices of allowing the SDK to get AWS credentials from environment variables or AMI roles.

### 0.0.3 (2013-12-25)

* Merge for pull request #2 to fix an issue where the latest version of the AWS SDK required a strict type on part number.

### 0.0.2 (2013-08-01)

* Improving the documentation

### 0.0.1 (2013-07-31)

* Initial release
