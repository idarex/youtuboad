var child_process = require('child_process');
var url = require('url');
var fs = require('fs');
var qs = require('querystring');
var path = require('path');

var request = require('request');
var express = require('express');
var bodyParser = require('body-parser');
var multer = require('multer');
var kue = require('kue');
var Promise = require('bluebird');

var app = express(),
    queue = kue.createQueue();

var rootDir = '/home/raffy/youtube';

var qiniuService = require('./qiniu');

var winston = require('./log');


// express middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(multer());


// app route
app.post('/youtube/transmit', function(req, res) {
  var videoUrl = req.body.url,
      taskId = req.body.task_id,
      videoTitle = req.body.video_title,
      videoDesc = req.body.video_desc;

  winston.log('info', 'post data', req.body);

  var job = queue.create('youtube-download', {
    videoUrl: videoUrl,
    taskId: taskId,
    videoTitle: videoTitle,
    videoDesc: videoDesc
  }).save(function(err) {
    if (err) {
      res.json({
        success: 0
      });
    }

    res.json({
      success: 1
    });
  });
});

// knock out
app.listen(2014);

// queue web-ui
kue.app.listen(3000);

// handle download queue job
queue.process('youtube-download', function(job, done) {
  var domain = require('domain').create();

  domain.on('error', function(err){
    done(err);
  });

  domain.run(function() {
    var videoUrl = job.data.videoUrl;

    winston.log('info', 'download', videoUrl);

    handleDownload(job.data).then(function() {
      done();
    }, function(err) {
      done(err);
    });
  });
});

function handleDownload(taskData) {
  var videoUrl = taskData.videoUrl,
      youtubeVid = qs.parse(url.parse(videoUrl).search.substr(1))['v'];

  var cmd = 'youtube-dl -F ' + videoUrl;

  return execCmd(cmd).bind({})
  .then(function(stdout) {
    var format = selectVideoFormat(stdout),
        cmd = ['youtube-dl', '-o', "'" + rootDir + "/%(title)s-%(id)s_origin.%(ext)s'", '-f', format, videoUrl].join(' ');

    winston.profile('download');

    return execCmd(cmd);
  }).then(function() {
    winston.profile('download');

    this.destFile = rootDir;

    return findFile(this.destFile, youtubeVid);
  }).then(function(filename) {
    var index = filename.lastIndexOf('_');

    this.originFilename = filename;
    this.filename = filename.substr(0, index) + filename.substr(index + 7);

    var cmd = ['sh', __dirname + '/scripts/addSubtitle.sh', '"' + this.originFilename.replace(/"/, '\\"') + '"', '"' + this.filename.replace(/"/, '\\"') + '"', __dirname + '/logo_text.png'].join(' ');

    return execCmd(cmd);
  }).then(function() {
    var title = taskData.videoTitle;

    var uploadYouku = ['python', __dirname + '/scripts/youkuUploader.py', '"' + title.replace(/"/, '\\"') + '"', '"' + this.filename.replace(/"/, '\\"') + '"', '"' + taskData.videoDesc.replace(/"/, '\\"') + '"'].join(' ');

    winston.profile('upload');

    var uploadBaidu = ['bypy', 'upload', '"' + this.filename.replace(/"/, '\\"') + '"'].join(' ');

    return Promise.all([execCmd(uploadYouku), execCmd(uploadBaidu)]);
  }).then(function(result) {
    winston.log('info', 'upload result', result);

    winston.profile('upload');

    this.vid = result[0];

    var cmd = ['youtube-dl', '-j', videoUrl].join(' ');

    return execCmd(cmd);
  }).then(function(str) {
    var videoData = JSON.parse(str);

    this.videoData = {
      youku_vid: this.vid,
      vid: videoData.display_id,
      title: videoData.title,
      description: videoData.description,
      duration: videoData.duration,
      channel: videoData.uploader,
      cover: videoData.thumbnail,
      task_id: taskData.taskId
    };

    winston.log('info', 'video data', this.videoData);

    return qiniuService.transferImage(this.videoData.cover);
  }).then(function(key) {
    this.videoData.cover = key;

    return commit(this.videoData);
  }).then(function() {
    return Promise.all([removeFile(this.filename), removeFile(this.originFilename)]);
  });
}

function selectVideoFormat(str) {
  winston.log('info', 'video formats', str);

  var lines = str.split(/[\n\r]/);

  var dashAudio = [],
      dashVideo = [];

  lines.forEach(function(line) {
    var items;

    if (/DASH audio/.test(line)) {
      items = line.split(/\s+/);
      dashAudio.push({
        formatCode: items[0]
      });
    } else if (/mp4.*DASH video/.test(line)) {
      items = line.split(/\s+/);
      dashVideo.push({
        formatCode: items[0]
      });
    }
  });

  return dashVideo[dashVideo.length - 1].formatCode + '+' + dashAudio[dashAudio.length - 1].formatCode;
}

function execCmd(cmd) {
  winston.log('info', 'exec command', cmd);
  var promise = new Promise(function(resolve, reject, progress) {
    child_process.exec(cmd, function(err, stdout, stderr) {
      if (err) {
        reject(err);

        return;
      }

      resolve(stdout);
    });
  });

  return promise;
}

function findFile(dir, key) {
  var promise = new Promise(function(resolve, reject) {
    fs.readdir(dir, function(err, files) {
      if (err) {
        reject(err);

        return;
      }

      var reg = new RegExp(key);

      files.forEach(function(file) {
        if (reg.test(file)) {

          resolve(path.resolve(dir, file));
        }
      });
    });
  });

  return promise;
}

function removeFile(filename) {
  return new Promise(function(resolve, reject) {
    fs.unlink(filename, function(err) {
      if (err) {
        // do something
	      reject(err);

        return;
      }

      resolve();
    });
  });
}

function commit(videoData) {
  return new Promise(function(resolve, reject) {
    request.post({
      url: 'http://admin.idarex.com/youtube-task/commit',
      form: videoData
    }, function(err, httpRes, body) {
      if (err) {
        reject(err);

        return;
      }

      body = JSON.parse(body);

      winston.log('info', 'commit response data', body);

      if (httpRes.statusCode === 200 && body.success == 1) {
        resolve();
      } else {
        reject(new Error('error in commit video info'));
      }
    });
  });
}

