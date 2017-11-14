// Sort by Date
"use strict";

let Categories = require.main.require('./src/categories')
let User = require.main.require('./src/user')
let Topics = require.main.require('./src/topics')
let SocketAdmin = require.main.require('./src/socket.io/admin')
let db = require.main.require('./src/database')

let async = require.main.require('async')
let winston = require.main.require('winston')
let nconf = require.main.require('nconf')
let _ = require.main.require('lodash')

let utils = require.main.require('./public/src/utils')

let version = '1.0.3'
let topicCount = 0;
let topicsProcessed = 0;

exports.init = (params, next) => {
  winston.info('[category-sort-by-topic-date] Loading category topics sort by date...')

  params.router.get('/admin/plugins/category-sort-by-topic-date', params.middleware.admin.buildHeader, renderAdmin)
  params.router.get('/api/admin/plugins/category-sort-by-topic-date', renderAdmin)

  function renderAdmin (req, res, next) {
    db.getObjectFields('global', ['topicCount'], function (err, data){
      topicCount = data.topicCount;
      res.render('admin/plugins/category-sort-by-topic-date', data);
    });
  }

  SocketAdmin.plugins.categorySortByTopicDate = {}
  SocketAdmin.plugins.categorySortByTopicDate.reindex = (socket, data, next) => {
    reindex(next)
  }
  SocketAdmin.plugins.categorySortByTopicDate.checkProgress = function(socket, data, callback) {
    var topicsPercent = topicCount ? (topicsProcessed / topicCount) * 100 : 0;
    var checkProgress = {
      topicsPercent: Math.min(100, topicsPercent.toFixed(2)),
      topicsProcessed: topicsPercent >= 100 ? topicCount : topicsProcessed
    };
    callback(null, checkProgress);
  };
  next()

  if (!(nconf.get('isPrimary') === 'true' && !nconf.get('jobsDisabled'))) return

  db.get('categorySortByTopicDate', function (err, ver) {
    if (err) return
    if (ver === version) return

    reindex()
  })
}

function reindex(next) {
  next = next || (() => {})

  winston.info('[category-sort-by-topic-date] Re-indexing topics...')

  async.waterfall([
    async.apply(db.getSortedSetRange, 'categories:cid', 0, -1),
    function (cids, next) {
      let keys = cids.map(function (cid) { return 'cid:' + cid + ':tids:csbt' })

      db.deleteAll(keys, next)
    },
    async.apply(db.getSortedSetRange, 'topics:tid', 0, -1),
    function (tids, next) {
      Topics.getTopicsFields(tids, ['tid', 'cid', 'timestamp'], next)
    },
    function (topics, next) {
      async.each(topics, function (topic, next) {
        db.sortedSetAdd('cid:' + topic.cid + ':tids:csbt', topic.timestamp, topic.tid, next)
        topicsProcessed++
      }, next)
    },
    async.apply(db.set, 'categorySortByTopicDate', version),
  ], (err) => {
    next(err)
    if (err) {
      winston.error(err)
    } else {
      winston.info('[category-sort-by-topic-date] Finished re-indexing topics.')
    }
  })
}

exports.topicPost = function (data) {
  let topic = data.topic

  db.sortedSetAdd('cid:' + topic.cid + ':tids:csbt', topic.timestamp,  topic.tid)

}

exports.topicPurge = function (data) {
  let topic = data.topic
  db.sortedSetRemove('cid:' + topic.cid + ':tids:csbt',  topic.tid)
}

exports.topicMove = function (topic) {
  Topics.getTopicField(topic.tid, 'timestamp', function (err, timestamp) {
    db.sortedSetRemove('cid:' + topic.fromCid + ':tids:csbt', topic.tid)
    db.sortedSetAdd('cid:' + topic.toCid + ':tids:csbt', timestamp, topic.tid)
  })
}

exports.categoryDelete = function (data) {
  let cid = data.cid

  db.delete('cid:' + cid + ':tids:csbt')
}

exports.adminBuild = (header, next) => {
  header.plugins.push({
    route : '/plugins/category-sort-by-topic-date',
    icon  : 'fa-sort-alpha-asc',
    name  : 'Category Sort by Topic Date'
  })

  next(null, header)
}

exports.getSortedSetRangeDirection = (data, callback) => {
  if (data.sort==='topics_newest_to_oldest' || data.sort ==="topics_oldest_to_newest") {
    data.direction = data.sort === 'topics_newest_to_oldest' ? 'highest-to-lowest' : 'lowest-to-highest';
  }

  return callback(null, data);
}

exports.buildTopicsSortedSet = (data, callback) => {
  if (data.data.sort==='topics_newest_to_oldest' || data.data.sort ==="topics_oldest_to_newest") {
    data.set="cid:" + data.data.cid + ":tids:csbt";
  }
  return callback(null, data);
}