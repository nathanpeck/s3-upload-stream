var Writable = require('stream').Writable,
    events = require("events");

// Set the S3 client to be used for this upload.
function Client(client) {
  if (this instanceof Client === false) {
    return new Client(client);
  }

  if (!client) {
    throw new Error('Must configure an S3 client before attempting to create an S3 upload stream.');
  }

  this.cachedClient = client;
}

// Generate a writeable stream which uploads to a file on S3.
Client.prototype.upload = function (destinationDetails, sessionDetails) {
  var cachedClient = this.cachedClient;
  var e = new events.EventEmitter();

  if (!sessionDetails) sessionDetails = {};

  // Create the writable stream interface.
  var ws = new Writable({
    highWaterMark: 4194304 // 4 MB
  });

  // Data pertaining to the overall upload.
  // If resumable parts are passed in, they must be free of gaps.
  var multipartUploadID = sessionDetails.UploadId ? sessionDetails.UploadId : null;
  var partNumber = sessionDetails.Parts ? (sessionDetails.Parts.length + 1) : 1;
  var partIds = sessionDetails.Parts || [];
  var receivedSize = 0;
  var uploadedSize = 0;

  // Light state management -
  //   started: used to fire 'ready' even on a quick resume
  //   paused:  used to govern manual pause/resume
  var started = false;
  var paused = false;

  // Parts which need to be uploaded to S3.
  var pendingParts = 0;
  var concurrentPartThreshold = 1;

  // Data pertaining to buffers we have received
  var receivedBuffers = [];
  var receivedBuffersLength = 0;
  var partSizeThreshold = 5242880;

  // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
  // of the multipart upload
  ws.maxPartSize = function (partSize) {
    if (partSize < 5242880)
      partSize = 5242880;

    partSizeThreshold = partSize;
    return ws;
  };

  ws.getMaxPartSize = function () {
    return partSizeThreshold;
  };

  // Set the maximum amount of data that we will keep in memory before flushing it to S3 as a part
  // of the multipart upload
  ws.concurrentParts = function (parts) {
    if (parts < 1)
      parts = 1;

    concurrentPartThreshold = parts;
    return ws;
  };

  ws.getConcurrentParts = function () {
    return concurrentPartThreshold;
  };

  // Handler to receive data and upload it to S3.
  ws._write = function (incomingBuffer, enc, next) {
    // Pause/resume check #1 out of 2:
    //   Block incoming writes immediately on pause.
    if (paused)
      e.once('resume', write);
    else
      write();

    function write() {
      absorbBuffer(incomingBuffer);

      if (receivedBuffersLength < partSizeThreshold)
        return next(); // Ready to receive more data in _write.

      // We need to upload some data
      uploadHandler(next);
    }
  };

  // Ask the stream to pause - will allow existing
  // part uploads to complete first.
  ws.pause = function () {
    // if already mid-pause, this does nothing
    if (paused) return false;

    // if there's no active upload, this does nothing
    if (!started) return false;

    paused = true;
    // give caller how many parts are mid-upload
    ws.emit('pausing', pendingParts);

    // if there are no parts outstanding, declare the stream
    // paused and return currently sent part details.
    if (pendingParts === 0)
      notifyPaused();

    // otherwise, the 'paused' event will get sent once the
    // last part finishes uploading.

    return true;
  };

  // Lift the pause, and re-kick off the uploading.
  ws.resume = function () {
    // if we're not paused, this does nothing
    if (!paused) return false;

    paused = false;
    e.emit('resume'); // internal event
    ws.emit('resume'); // external event

    return true;
  };

  // when pausing, return relevant pause state to client
  var notifyPaused = function () {
    ws.emit('paused', {
      UploadId: multipartUploadID,
      Parts: partIds,
      uploadedSize: uploadedSize
    });
  };

  // Concurrently upload parts to S3.
  var uploadHandler = function (next) {

    // If this is the first part, and we're just starting,
    // but we have a multipartUploadID, then we're beginning
    // a resume and can fire the 'ready' event externally.
    if (multipartUploadID && !started)
      ws.emit('ready', multipartUploadID);

    started = true;

    if (pendingParts < concurrentPartThreshold) {
      // Has the MPU been created yet?
      if (multipartUploadID)
        upload(); // Upload the part immediately.
      else {
        e.once('ready', upload); // Wait until multipart upload is initialized.
        createMultipartUpload();
      }
    }
    else {
      // Block uploading (and receiving of more data) until we upload
      // some of the pending parts
      e.once('part', upload);
    }

    function upload() {

      // Pause/resume check #2 out of 2:
      //   Block queued up parts until resumption.
      if (paused)
        e.once('resume', uploadNow);
      else
        uploadNow();

      function uploadNow() {
        pendingParts++;
        flushPart(function (partDetails) {
          --pendingParts;
          e.emit('part'); // Internal event
          ws.emit('part', partDetails); // External event

          // if we're paused and this was the last outstanding part,
          // we can notify the caller that we're really paused now.
          if (paused && pendingParts === 0)
            notifyPaused();
        });
        next();
      }
    }
  };

  // Absorb an incoming buffer from _write into a buffer queue
  var absorbBuffer = function (incomingBuffer) {
    receivedBuffers.push(incomingBuffer);
    receivedBuffersLength += incomingBuffer.length;
  };

  // Take a list of received buffers and return a combined buffer that is exactly
  // partSizeThreshold in size.
  var preparePartBuffer = function () {
    // Combine the buffers we've received and reset the list of buffers.
    var combinedBuffer = Buffer.concat(receivedBuffers, receivedBuffersLength);
    receivedBuffers.length = 0; // Trick to reset the array while keeping the original reference
    receivedBuffersLength = 0;

    if (combinedBuffer.length > partSizeThreshold) {
      // The combined buffer is too big, so slice off the end and put it back in the array.
      var remainder = new Buffer(combinedBuffer.length - partSizeThreshold);
      combinedBuffer.copy(remainder, 0, partSizeThreshold);
      receivedBuffers.push(remainder);
      receivedBuffersLength = remainder.length;

      // Return the perfectly sized part.
      var uploadBuffer = new Buffer(partSizeThreshold);
      combinedBuffer.copy(uploadBuffer, 0, 0, partSizeThreshold);
      return uploadBuffer;
    }
    else {
      // It just happened to be perfectly sized, so return it.
      return combinedBuffer;
    }
  };

  // Flush a part out to S3.
  var flushPart = function (callback) {
    var partBuffer = preparePartBuffer();

    var localPartNumber = partNumber;
    partNumber++;
    receivedSize += partBuffer.length;
    cachedClient.uploadPart(
      {
        Body: partBuffer,
        Bucket: destinationDetails.Bucket,
        Key: destinationDetails.Key,
        UploadId: multipartUploadID,
        PartNumber: localPartNumber
      },
      function (err, result) {
        if (err)
          abortUpload('Failed to upload a part to S3: ' + JSON.stringify(err));
        else {
          uploadedSize += partBuffer.length;
          partIds[localPartNumber - 1] = {
            ETag: result.ETag,
            PartNumber: localPartNumber
          };

          callback({
            ETag: result.ETag,
            PartNumber: localPartNumber,
            receivedSize: receivedSize,
            uploadedSize: uploadedSize
          });
        }
      }
    );
  };

  // Overwrite the end method so that we can hijack it to flush the last part and then complete
  // the multipart upload
  ws.originalEnd = ws.end;
  ws.end = function (Part, encoding, callback) {
    ws.originalEnd(Part, encoding, function afterDoneWithOriginalEnd() {
      if (Part)
        absorbBuffer(Part);

      // Upload any remaining data
      var uploadRemainingData = function () {
        if (receivedBuffersLength > 0) {
          uploadHandler(uploadRemainingData);
          return;
        }

        if (pendingParts > 0) {
          setTimeout(uploadRemainingData, 50); // Wait 50 ms for the pending uploads to finish before trying again.
          return;
        }

        completeUpload();
      };

      uploadRemainingData();

      if (typeof callback == 'function')
        callback();
    });
  };

  // Turn all the individual parts we uploaded to S3 into a finalized upload.
  var completeUpload = function () {
    // There is a possibility that the incoming stream was empty, therefore the MPU never started
    // and cannot be finalized.
    if (multipartUploadID) {
      cachedClient.completeMultipartUpload(
        {
          Bucket: destinationDetails.Bucket,
          Key: destinationDetails.Key,
          UploadId: multipartUploadID,
          MultipartUpload: {
            Parts: partIds
          }
        },
        function (err, result) {
          if (err)
            abortUpload('Failed to complete the multipart upload on S3: ' + JSON.stringify(err));
          else {
            // Emit both events for backwards compatibility, and to follow the spec.
            ws.emit('uploaded', result);
            ws.emit('finish', result);
            started = false;
          }
        }
      );
    }
  };

  // When a fatal error occurs abort the multipart upload
  var abortUpload = function (rootError) {
    cachedClient.abortMultipartUpload(
      {
        Bucket: destinationDetails.Bucket,
        Key: destinationDetails.Key,
        UploadId: multipartUploadID
      },
      function (abortError) {
        if (abortError)
          ws.emit('error', rootError + '\n Additionally failed to abort the multipart upload on S3: ' + abortError);
        else
          ws.emit('error', rootError);
      }
    );
  };

  var createMultipartUpload = function () {
    cachedClient.createMultipartUpload(
      destinationDetails,
      function (err, data) {
        if (err)
          ws.emit('error', 'Failed to create a multipart upload on S3: ' + JSON.stringify(err));
        else {
          multipartUploadID = data.UploadId;
          ws.emit('ready', multipartUploadID);
          e.emit('ready'); // Internal event
        }
      }
    );
  };

  return ws;
};

Client.globalClient = null;

Client.client = function (options) {
  Client.globalClient = new Client(options);
  return Client.globalClient;
};

Client.upload = function (destinationDetails, sessionDetails) {
  if (!Client.globalClient) {
    throw new Error('Must configure an S3 client before attempting to create an S3 upload stream.');
  }
  return Client.globalClient.upload(destinationDetails, sessionDetails);
};

module.exports = Client;
