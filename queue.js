var child_process = require('child_process');
var url = require('url');
var fs = require('fs');
var qs = require('querystring');
var path = require('path');

var Promise = require('bluebird');
var request = require('request');

var kue = require('kue');

var winston = require('./log');
var qiniuService = require('./qiniu');


var queue = kue.createQueue();

var rootDir = '/home/raffy/youtube';

// handle download queue job
queue.process('youtube-download', 3, function(job, done) {
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

function retry(taskId) {
  return getJobs('failed').then(function(jobs) {
    var job;

    if (jobs.length && (job = findJob(jobs, taskId))) {
      return job;
    } else {
      return getJobs('complete');
    }
  }).then(function(data) {
    var job;

    if (Array.isArray(data)) {
      job = findJob(data, taskId);
    } else {
      job = data;
    }

    if (job) {
      return retryJob(job);
    } else {
      return Promise.reject();
    }
  });
}

function getJobs(state) {
  return new Promise(function(resolve, reject) {
    kue.Job.rangeByType('youtube-download', state, 0, -1, 'asc', function(err, jobs) {
      if (err) {
        reject(err);

        return;
      }

      resolve(jobs);
    });
  });
}

function findJob(jobs, taskId) {
  var job;

  for (var i = 0, l = jobs.length; i < l; i ++) {
    job = jobs[i];

    if (job.data && job.data.taskId === taskId) {
      return job;
    }
  }
}

function retryJob(job) {
  return new Promise(function(resolve, reject) {
    job.state('inactive', function(err, res) {
      if (err) {
        reject(err);

        return;
      }

      resolve();
    });
  });
}

function handleDownload(taskData) {
  var videoUrl = taskData.videoUrl,
      youtubeVid = qs.parse(url.parse(videoUrl).search.substr(1))['v'];

  var cmd = 'youtube-dl -F ' + videoUrl;

  return execCmd(cmd).bind({})
  .then(function(stdout) {
    var format = selectVideoFormat(stdout),
        cmd = ['youtube-dl', '-o', "'" + rootDir + "/%(title)s-%(id)s.%(ext)s'", '-f', format, videoUrl].join(' ');

    winston.profile('download');

    return execCmd(cmd);
  }).then(function() {
    winston.profile('download');

    this.destFile = rootDir;

    return findFile(this.destFile, youtubeVid);
  }).then(function(filename) {
    this.filename = filename;

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
    return removeFile(this.filename);
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

exports.queue = queue;
exports.retry = retry;

