// Sort by Date

var Categories = require.main.require('./src/categories')
var User = require.main.require('./src/user')
var Topics = require.main.require('./src/topics')
var SocketAdmin = require.main.require('./src/socket.io/admin')
var db = require.main.require('./src/database')

var async = require.main.require('async')
var winston = require.main.require('winston')
var nconf = require.main.require('nconf')
var _ = require.main.require('lodash')

var utils = require.main.require('./public/src/utils')

var version = '1.4.0'

exports.init = (params, next) => {
  winston.info('[sort-by-date] Loading sort by date...')

  params.router.get('/admin/plugins/category-sort-by-date', params.middleware.admin.buildHeader, renderAdmin)
  params.router.get('/api/admin/plugins/category-sort-by-date', renderAdmin)

  function renderAdmin (req, res, next) {
    res.render('admin/plugins/category-sort-by-date', {})
  }

	var getTopicIds = Categories.getTopicIds

  Categories.getTopicIds = function (data, next) {
	  var { sort, cid, start, stop, } = data

    if (sort !== 'a_z' && sort !== 'z_a') return getTopicIds(data, next)

	  var pinnedTids

	  var method, min, max, set

    if (sort === 'z_a') {
      method = 'getSortedSetRevRangeByLex'
      min = '+'
      max = '-'
    } else {
      method = 'getSortedSetRangeByLex'
      min = '-'
      max = '+'
    }

    async.waterfall([
      next => {
		var dataForPinned = _.cloneDeep(data)

        dataForPinned.start = 0
        dataForPinned.stop = -1

        Categories.getPinnedTids(dataForPinned, next)
      },
      (_pinnedTids, next) => {
		  var totalPinnedCount = _pinnedTids.length

        pinnedTids = _pinnedTids.slice(start, stop === -1 ? undefined : stop + 1);

		  var pinnedCount = pinnedTids.length;

		  var topicsPerPage = stop - start + 1;

		  var normalTidsToGet = Math.max(0, topicsPerPage - pinnedCount);

        if (!normalTidsToGet && stop !== -1) return next(null, [])

        set = `cid:${cid}:tids:lex`

        if (start > 0 && totalPinnedCount) start -= totalPinnedCount - pinnedCount

        stop = stop === -1 ? stop : start + normalTidsToGet - 1

        db[method](set, min, max, start, stop - start, next)
      },
      (topicValues, next) => {
		  var tids = []

        topicValues.forEach(function (value) {
          tid = value.split(':')
          tid = tid[tid.length - 1]
          tids.push(tid)
        })

        next(null, tids)

        db.isSetMembers('sortbydate:purged', tids, function (err, isMember) {
          for (let i = 0; i < tids.length; i++) {
            if (isMember[i]) {
              db.sortedSetRemove(set, tids[i])
              db.setRemove('sortbydate:purged', tids[i])
            }
          }
        })
      },
      (normalTids, next) => {
        normalTids = normalTids.filter(tid => pinnedTids.indexOf(tid) === -1)

        next(null, pinnedTids.concat(normalTids))
      },
    ], next)
  }

  SocketAdmin.sortbydate = {}
  SocketAdmin.sortbydate.reindex = (socket, data, next) => {
    reindex(next)
  }

  next()

  if (!(nconf.get('isPrimary') === 'true' && !nconf.get('jobsDisabled'))) return

  db.get('sortbydate', function (err, ver) {
    if (err) return
    if (ver === version) return

    reindex()
  })
}

function reindex(next) {
  next = next || (() => {})

  winston.info('[sort-by-date] Re-indexing topics...')

  async.waterfall([
    async.apply(db.getSortedSetRange, 'categories:cid', 0, -1),
    function (cids, next) {
		var keys = cids.map(function (cid) { return 'cid:' + cid + ':tids:lex' })

      db.deleteAll(keys, next)
    },
    async.apply(db.getSortedSetRange, 'topics:tid', 0, -1),
    function (tids, next) {
      Topics.getTopicsFields(tids, ['tid', 'cid', 'title'], next)
    },
    function (topics, next) {
      async.each(topics, function (topic, next) {
        db.sortedSetAdd('cid:' + topic.cid + ':tids:lex', 0, topic.title.split('/')[1] + ':' + topic.tid, next)
      }, next)
    },
    async.apply(db.set, 'sortbydate', version),
    async.apply(db.delete, 'sortbydate:purged')
  ], (err) => {
    next(err)
    if (err) {
      winston.error(err)
    } else {
      winston.info('[sort-by-date] Finished re-indexing topics.')
    }
  })
}

exports.topicEdit = function (data, next) {
	var topic = data.topic

  Topics.getTopicField(topic.tid, 'title', function (err, title) {
    if (title !== topic.title) {
		var oldSlug = utils.slugify(title) || 'topic'

      db.sortedSetRemove('cid:' + topic.cid + ':tids:lex', oldSlug + ':' + topic.tid)
      db.sortedSetAdd('cid:' + topic.cid + ':tids:lex', 0, topic.slug.split('/')[1] + ':' + topic.tid)
    }

    next(null, data)
  })
}

exports.topicPost = function (data) {
	var topic = data.topic

  db.sortedSetAdd('cid:' + topic.cid + ':tids:lex', 0, topic.slug.split('/')[1] + ':' + topic.tid)

	reindex()
}

exports.topicPurge = function (data) {
	var tid = data.topic.tid

  db.setAdd('sortbydate:purged', tid)
}

exports.topicMove = function (topic) {
  Topics.getTopicField(topic.tid, 'slug', function (err, slug) {
    db.sortedSetRemove('cid:' + topic.fromCid + ':tids:lex', slug.split('/')[1] + ':' + topic.tid)
    db.sortedSetAdd('cid:' + topic.toCid + ':tids:lex', 0, slug.split('/')[1] + ':' + topic.tid)
  })
}

exports.categoryDelete = function (data) {
	var cid = data.cid

  db.delete('cid:' + cid + ':tids:lex')
}

exports.adminBuild = (header, next) => {
  header.plugins.push({
    route : '/plugins/category-sort-by-date',
    icon  : 'fa-sort-alpha-asc',
    name  : 'Category Sort by Date'
  })

  next(null, header)
}
