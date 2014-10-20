var expect     = require('chai').expect,
    fs         = require('fs'),
    Writable   = require('stream').Writable;

// Define a stubbed out version of the AWS S3 Node.js client
var AWSstub = {
  S3: function () {
    this.createMultipartUpload = function (details, callback) {
      // Make sure that this AWS function was called with the right parameters.
      expect(details).to.have.property('Bucket');
      expect(details.Key).to.be.a('string');

      expect(details).to.have.property('Key');
      expect(details.Key).to.be.a('string');

      if (details.Key == 'create-fail') {
        // Trigger a simulated error when a magic file name is used.
        callback('Simulated failure from mocked API');
      }
      else {
        callback(null, {
          UploadId: 'upload-id'
        });
      }
    };

    this.uploadPart = function (details, callback) {
      // Make sure that all the properties are there
      expect(details).to.have.property('Body');
      expect(details.Body).to.be.instanceof(Buffer);

      expect(details).to.have.property('Bucket');
      expect(details.Bucket).to.equal('test-bucket-name');

      expect(details).to.have.property('Key');
      expect(details.Key).to.be.a('string');

      expect(details).to.have.property('UploadId');
      expect(details.UploadId).to.contain('upload-id');

      expect(details).to.have.property('PartNumber');
      expect(details.PartNumber).to.be.an.integer;

      if (details.Key == 'upload-fail') {
        callback('Simulated failure from mocked API');
      }
      else {
        // Return an ETag
        callback(null, {
          ETag: 'etag'
        });
      }
    };

    this.abortMultipartUpload = function (details, callback) {
      // Make sure that all the properties are there
      expect(details).to.have.property('Bucket');
      expect(details.Bucket).to.equal('test-bucket-name');

      expect(details).to.have.property('Key');
      expect(details.Key).to.be.a('string');

      expect(details).to.have.property('UploadId');
      expect(details.UploadId).to.contain('upload-id');

      if (details.Key == 'abort-fail') {
        // Trigger a simulated error when a magic file name is used.
        callback('Simulated failure from mocked API');
      }
      else {
        callback();
      }
    };

    this.completeMultipartUpload = function (details, callback) {
      // Make sure that all the properties are there
      expect(details).to.have.property('Bucket');
      expect(details.Bucket).to.equal('test-bucket-name');

      expect(details).to.have.property('Key');
      expect(details.Key).to.be.a('string');

      expect(details).to.have.property('UploadId');
      expect(details.UploadId).to.contain('upload-id');

      expect(details).to.have.property('MultipartUpload');
      expect(details.MultipartUpload).to.an.object;

      expect(details.MultipartUpload).to.have.property('Parts');
      expect(details.MultipartUpload.Parts).to.an.array;

      details.MultipartUpload.Parts.forEach(function (partNumber) {
        expect(partNumber).to.be.an.integer;
      });

      if (details.Key == 'complete-fail' || details.Key == 'abort-fail') {
        // Trigger a simulated error when a magic file name is used.
        callback('Simulated failure from mocked API');
      }
      else {
        callback(null, {
          ETag: 'etag'
        });
      }
    };
  }
};

var s3StreamClient = require('../lib/s3-upload-stream.js')(new AWSstub.S3());

describe('Creating upload client', function () {
  describe('Without specifying an S3 client', function () {
    var uploadStream;

    it('should throw an error', function (done) {
      var BadStreamClient = require('../lib/s3-upload-stream.js');

      try {
        uploadStream = BadStreamClient.upload({
          "Bucket": "test-bucket-name",
          "Key": "test-file-name"
        });

        done();
      }
      catch (e) {
        done();
      }
    });
  });

  describe('After specifying an S3 client', function () {
    var uploadStream;

    it('should return an instance of Writable stream', function () {
      var GoodStreamClient = require('../lib/s3-upload-stream.js')(new AWSstub.S3());

      uploadStream = GoodStreamClient.upload({
        "Bucket": "test-bucket-name",
        "Key": "test-file-name"
      });

      uploadStream.on('error', function () {
        throw "Did not expect to receive an error";
      });

      expect(uploadStream).to.be.instanceof(Writable);
    });
  });
});

describe('Stream Methods', function () {
  var uploadStream;

  before(function (done) {
    uploadStream = s3StreamClient.upload({
      "Bucket": "test-bucket-name",
      "Key": "test-file-name"
    });

    uploadStream.on('error', function () {
      throw "Did not expect to receive an error";
    });

    done();
  });

  it('writable stream should have a maxPartSize method', function () {
    expect(uploadStream.maxPartSize).to.be.a('function');
  });

  it('writable stream should have a concurrentParts method', function () {
    expect(uploadStream.concurrentParts).to.be.a('function');
  });

  describe('Setting max part size to a value greater than 5 MB', function () {
    it('max part size should be set to that value', function () {
      uploadStream.maxPartSize(20971520);
      expect(uploadStream.getMaxPartSize()).to.equal(20971520);
    });
  });

  describe('Setting max part size to a value less than 5 MB', function () {
    it('max part size should be set to 5 MB exactly', function () {
      uploadStream.maxPartSize(4242880);
      expect(uploadStream.getMaxPartSize()).to.equal(5242880);
    });
  });

  describe('Setting concurrent parts to number greater than 1', function () {
    it('concurrent parts should be set to that number', function () {
      uploadStream.concurrentParts(5);
      expect(uploadStream.getConcurrentParts()).to.equal(5);
    });
  });

  describe('Setting concurrent parts to number less than 1', function () {
    it('concurrent parts should be set to 1', function () {
      uploadStream.concurrentParts(-2);
      expect(uploadStream.getConcurrentParts()).to.equal(1);
    });
  });
});

describe('Piping data into the writable upload stream', function () {
  var uploadStream;

  before(function (done) {
    uploadStream = s3StreamClient.upload({
      "Bucket": "test-bucket-name",
      "Key": "test-file-name"
    });

    uploadStream.on('error', function () {
      throw "Did not expect to receive an error";
    });

    done();
  });

  it('should emit valid part and uploaded events', function (done) {
    var file = fs.createReadStream(process.cwd() + '/tests/test.js');

    var ready = false, part = false, uploaded = false;

    uploadStream.on('ready', function(uploadId) {
      ready = true;

      expect(uploadId).to.equal('upload-id');

      if (ready & part & uploaded)
        done();
    });

    uploadStream.on('part', function (details) {
      part = true;

      expect(details).to.have.property('ETag');
      expect(details.ETag).to.equal('etag');

      expect(details).to.have.property('PartNumber');
      expect(details.PartNumber).to.equal(1);

      expect(details).to.have.property('receivedSize');
      expect(details.receivedSize).to.be.an.integer;

      expect(details).to.have.property('uploadedSize');
      expect(details.uploadedSize).to.be.an.integer;

      if (ready & part & uploaded)
        done();
    });

    uploadStream.on('uploaded', function () {
      uploaded = true;

      if (ready & part & uploaded)
        done();
    });

    file.on('open', function () {
      file.pipe(uploadStream);
    });

    file.on('error', function () {
      throw 'Error! Unable to open the file for reading';
    });
  });
});


/*
  Differences from normal creation:
  * Constructor passes multipartUploadId and part info
  * 'ready' event fires with given multipartUploadID
  * First sent part number should start 1 above those given

  ASSUMPTION:
    Parts are passed in without gaps. Part number is calculated
    based on array length, not at inspecting given part numbers.
*/
describe('Piping data into a resumed upload stream', function () {
  var uploadStream;

  before(function (done) {
    uploadStream = s3StreamClient.upload({
      Bucket: "test-bucket-name",
      Key: "test-file-name"
    }, {
      // when 'ready' event fires, should have this ID
      UploadId: "this-tests-specific-upload-id",
      Parts: [
        {
          PartNumber: 1,
          ETag: "etag-1"
        },
        {
          PartNumber: 2,
          ETag: "etag-2"
        }
      ]
    });

    uploadStream.on('error', function () {
      throw "Did not expect to receive an error";
    });

    done();
  });

  it('should emit valid part and uploaded events', function (done) {
    var file = fs.createReadStream(process.cwd() + '/tests/test.js');

    var ready = false, part = false, uploaded = false;

    uploadStream.on('ready', function(uploadId) {
      ready = true;

      expect(uploadId).to.equal('this-tests-specific-upload-id');

      if (ready & part & uploaded)
        done();
    });

    uploadStream.on('part', function (details) {
      part = true;

      expect(details).to.have.property('ETag');
      expect(details.ETag).to.equal('etag');

      // part number should be one more than the highest given
      expect(details).to.have.property('PartNumber');
      expect(details.PartNumber).to.equal(3);

      expect(details).to.have.property('receivedSize');
      expect(details.receivedSize).to.be.an.integer;

      expect(details).to.have.property('uploadedSize');
      expect(details.uploadedSize).to.be.an.integer;

      if (ready & part & uploaded)
        done();
    });

    uploadStream.on('uploaded', function () {
      uploaded = true;

      if (ready & part & uploaded)
        done();
    });

    file.on('open', function () {
      file.pipe(uploadStream);
    });

    file.on('error', function () {
      throw 'Error! Unable to open the file for reading';
    });
  });
});

describe('S3 Error catching', function () {
  describe('Error creating multipart upload', function () {
    it('should emit an error', function (done) {
      var uploadStream = s3StreamClient.upload({
        "Bucket": "test-bucket-name",
        "Key": "create-fail"
      });

      var file = fs.createReadStream(process.cwd() + '/tests/test.js');

      uploadStream.on('error', function () {
        done();
      });

      file.on('open', function () {
        file.pipe(uploadStream);
      });
    });
  });

  describe('Error uploading part', function () {
    var uploadStream;

    before(function (done) {
      uploadStream = s3StreamClient.upload({
        "Bucket": "test-bucket-name",
        "Key": "upload-fail"
      });
      done();
    });

    it('should emit an error', function (done) {
      var file = fs.createReadStream(process.cwd() + '/tests/test.js');

      uploadStream.on('error', function (err) {
        expect(err).to.be.a('string');
        done();
      });

      file.on('open', function () {
        file.pipe(uploadStream);
      });

      file.on('error', function () {
        throw 'Error! Unable to open the file for reading';
      });
    });
  });

  describe('Error completing upload', function () {
    var uploadStream;

    before(function (done) {
      uploadStream = s3StreamClient.upload({
        "Bucket": "test-bucket-name",
        "Key": "complete-fail"
      });
      done();
    });

    it('should emit an error', function (done) {
      var file = fs.createReadStream(process.cwd() + '/tests/test.js');

      uploadStream.on('error', function (err) {
        expect(err).to.be.a('string');
        done();
      });

      file.on('open', function () {
        file.pipe(uploadStream);
      });

      file.on('error', function () {
        throw 'Error! Unable to open the file for reading';
      });
    });
  });

  describe('Error aborting upload', function () {
    var uploadStream;

    before(function (done) {
      uploadStream = s3StreamClient.upload({
        "Bucket": "test-bucket-name",
        "Key": "abort-fail"
      });
      done();
    });

    it('should emit an error', function (done) {
      var file = fs.createReadStream(process.cwd() + '/tests/test.js');

      uploadStream.on('error', function (err) {
        expect(err).to.be.a('string');
        done();
      });

      file.on('open', function () {
        file.pipe(uploadStream);
      });

      file.on('error', function () {
        throw 'Error! Unable to open the file for reading';
      });
    });
  });
});
