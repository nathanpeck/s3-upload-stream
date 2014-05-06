var expect     = require('chai').expect,
    fs         = require('fs'),
    Writable   = require('stream').Writable;

// Define a stubbed out version of the AWS S3 Node.js client
var AWSstub = {
  S3: function (connectionDetails) {

    if (connectionDetails) {
      expect(connectionDetails).to.have.property('accessKeyId');
      expect(connectionDetails.accessKeyId).to.equal('accessKey');

      expect(connectionDetails).to.have.property('secretAccessKey');
      expect(connectionDetails.secretAccessKey).to.equal('secretAccessKey');

      expect(connectionDetails).to.have.property('region');
      expect(connectionDetails.region).to.equal('region');
    }

    this.createMultipartUpload = function (details, callback) {
      // Make sure that this AWS function was called with the right parameters.
      expect(details).to.have.property('Bucket');
      expect(details).to.have.property('Key');

      // Make the callback with a fake upload ID.
      callback(null, {
        UploadId: 'upload-id'
      });
    };

    this.uploadPart = function (details, callback) {
      // Make sure that all the properties are there
      expect(details).to.have.property('Body');
      expect(details.Body).to.be.instanceof(Buffer);

      expect(details).to.have.property('Bucket');
      expect(details.Bucket).to.equal('test-bucket-name');

      expect(details).to.have.property('Key');
      expect(details.Key).to.equal('test-file-name');

      expect(details).to.have.property('UploadId');
      expect(details.UploadId).to.equal('upload-id');

      expect(details).to.have.property('PartNumber');
      expect(details.PartNumber).to.an.integer;

      // Return an ETag
      callback(null, {
        ETag: 'etag'
      });
    };

    this.completeMultipartUpload = function (details, callback) {
      // Make sure that all the properties are there
      expect(details).to.have.property('Bucket');
      expect(details.Bucket).to.equal('test-bucket-name');

      expect(details).to.have.property('Key');
      expect(details.Key).to.equal('test-file-name');

      expect(details).to.have.property('UploadId');
      expect(details.UploadId).to.equal('upload-id');

      expect(details).to.have.property('MultipartUpload');
      expect(details.MultipartUpload).to.an.object;

      expect(details.MultipartUpload).to.have.property('Parts');
      expect(details.MultipartUpload.Parts).to.an.array;

      details.MultipartUpload.Parts.forEach(function (partNumber) {
        expect(partNumber).to.be.an.integer;
      });

      // Return an ETag
      callback(null, {
        ETag: 'etag'
      });
    };
  }
};

// Override the aws-sdk with out stubbed out version.
var proxyquire = require('proxyquire');
proxyquire.noCallThru();

var UploadStream = proxyquire('../lib/s3-upload-stream.js', {'aws-sdk': AWSstub}).Uploader;

describe('Creating upload stream', function () {
  describe('With no S3 connection details passed to constructor', function () {
    var uploadStream, uploadObject;

    before(function (done) {
      uploadObject = new UploadStream(
        {
          "Bucket": "test-bucket-name",
          "Key": "test-file-name"
        },
        function (err, data) {
          expect(err).to.equal(null);
          uploadStream = data;
          done();
        }
      );
    });

    it('response should be instance of writable stream', function () {
      expect(uploadStream).to.be.instanceof(Writable);
    });
  });

  describe('With an S3 client passed to constructor', function () {
    var uploadStream, uploadObject;

    before(function (done) {
      uploadObject = new UploadStream(
        {
          s3Client: new AWSstub.S3()
        },
        {
          "Bucket": "test-bucket-name",
          "Key": "test-file-name"
        },
        function (err, data) {
          expect(err).to.equal(null);
          uploadStream = data;
          done();
        }
      );
    });

    it('response should be instance of writable stream', function () {
      expect(uploadStream).to.be.instanceof(Writable);
    });
  });

  describe('With hardcoded AWS API credentials passed to constructor', function () {
    var uploadStream, uploadObject;

    before(function (done) {
      uploadObject = new UploadStream(
        {
          accessKeyId: 'accessKey',
          secretAccessKey: 'secretAccessKey',
          region: 'region'
        },
        {
          "Bucket": "test-bucket-name",
          "Key": "test-file-name"
        },
        function (err, data) {
          expect(err).to.equal(null);
          uploadStream = data;
          done();
        }
      );
    });

    it('response should be instance of writable stream', function () {
      expect(uploadStream).to.be.instanceof(Writable);
    });
  });
});

describe('Piping data into the upload stream', function () {
  var uploadStream, uploadObject;

  before(function (done) {
    uploadObject = new UploadStream(
      {
        s3Client: new AWSstub.S3()
      },
      {
        "Bucket": "test-bucket-name",
        "Key": "test-file-name"
      },
      function (err, data) {
        expect(err).to.equal(null);
        uploadStream = data;
        done();
      }
    );
  });

  it('should emit valid chunk and uploaded events', function (done) {
    var file = fs.createReadStream(process.cwd() + '/tests/test.js');

    var chunk = false, uploaded = false;

    uploadStream.on('chunk', function (details) {
      chunk = true;

      expect(details).to.have.property('ETag');
      expect(details.ETag).to.equal('etag');

      expect(details).to.have.property('PartNumber');
      expect(details.PartNumber).to.be.an.integer;

      expect(details).to.have.property('receivedSize');
      expect(details.receivedSize).to.be.an.integer;

      expect(details).to.have.property('uploadedSize');
      expect(details.uploadedSize).to.be.an.integer;

      if (chunk & uploaded)
        done();
    });

    uploadStream.on('uploaded', function () {
      uploaded = true;

      if (chunk & uploaded)
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
