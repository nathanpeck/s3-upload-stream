#!/usr/bin/env node

var Uploader = require('../lib/s3-upload-stream').Uploader,
		zlib     = require('zlib'),
		fs       = require('fs');

var read = fs.createReadStream('./path/to/file.ext');
var compress = zlib.createGzip();

var UploadStreamObject = new Uploader(
	//Connection details.
	{
		"accessKeyId": "REDACTED",
		"secretAccessKey": "REDACTED",
		"region": "us-east-1"
	},
	//Upload destination details.
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
			uploadStream.on('chunk', function (data) {
				console.log(data);
			});
			uploadStream.on('uploaded', function (data) {
				console.log(data);
			});
			read.pipe(compress).pipe(uploadStream);
		}
	}
);

