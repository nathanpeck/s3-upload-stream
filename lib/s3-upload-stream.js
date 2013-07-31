var Writable = require('stream').Writable,
		AWS      = require('aws-sdk'),
		async    = require('async');

module.exports = {

	//Generate a writeable stream which uploads to a file on S3.
	Uploader: function (connection, destinationDetails, doneCreatingUploadStream) {
		var self = this;

		//Create the writeable stream interface.
		self.ws = Writable({
			highWaterMark: 4194304 // 4 MB
		});

		self.partNumber = 1;
		self.parts = [];
		self.receivedSize = 0;
		self.uploadedSize = 0;
		self.currentChunk = Buffer(0);
		self.maxChunkSize = 5242880;

		//Create a client for this request.
		if(typeof connection.s3Client == 'undefined')
		{
			this.s3Client = new AWS.S3({
				apiVersion: 'latest',
				accessKeyId: connection.accessKeyId,
				secretAccessKey: connection.secretAccessKey,
				region: connection.region
			});
		}
		else
		{
			this.s3Client = connection.s3Client;
		}

		//Handler to receive data and upload it to S3.
		self.ws._write = function (chunk, enc, next) {
			self.currentChunk = Buffer.concat([self.currentChunk, chunk]);

			// If the current chunk buffer is getting to large, or the stream piped in has ended then flush
			// the chunk buffer downstream to S3 via the multipart upload API.
			if(self.currentChunk.length > self.maxChunkSize) {
				self.flushChunk(next);
			}
			else
			{
				next();
      }
		};

		// Overwrite the end method so that we can hijack it to flush the last part and then complete
		// the multipart upload
		self.ws.originalEnd = self.ws.end;
		self.ws.end = function (chunk, encoding, callback) {
			self.ws.originalEnd(chunk, encoding, callback);
			self.flushChunk();
		};

		self.flushChunk = function (callback) {
			var uploadingChunk = Buffer(self.currentChunk.length);
			self.currentChunk.copy(uploadingChunk);

			var localChunkNumber = self.partNumber;
			self.partNumber++;
			self.receivedSize += uploadingChunk.length;
			self.s3Client.uploadPart(
				{
					Body: uploadingChunk,
					Bucket: destinationDetails.Bucket,
					Key: destinationDetails.Key,
					UploadId: self.multipartUploadID,
					PartNumber: localChunkNumber.toString()
				},
				function (err, result)
				{
					if(typeof callback == 'function')
						callback();

					if(err)
						self.ws.emit('error', err);
					else
					{
						self.uploadedSize += uploadingChunk.length;
						self.parts[localChunkNumber-1] = {
							ETag: result.ETag,
							PartNumber: localChunkNumber
						};

						self.ws.emit('chunk', {
							ETag: result.ETag,
							PartNumber: localChunkNumber,
							receivedSize: self.receivedSize,
							uploadedSize: self.uploadedSize
						});

						// The incoming stream has finished giving us all data and we have finished uploading all that data to S3.
						// So tell S3 to assemble those parts we uploaded into the final product.
						if(self.ws._writableState.ended === true & self.uploadedSize == self.receivedSize)
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
									if(err)
										self.ws.emit('error', err);
									else
										self.ws.emit('uploaded', result);
								}
							);
						}
					}
				}
			);
			self.currentChunk = Buffer(0);
		};

		//Use the S3 client to initialize a multipart upload to S3.
		this.s3Client.createMultipartUpload(
			destinationDetails,
			function (err, data)
			{
				if(err)
					doneCreatingUploadStream(err, data);
				else
				{
					self.multipartUploadID = data.UploadId;

					//Return the writeable stream for the client to pipe into.
					doneCreatingUploadStream(null, self.ws);
				}
			}
		);
	}

};
