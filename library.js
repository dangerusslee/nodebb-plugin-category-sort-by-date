// Sort by Title

let Categories = require.main.require('./src/categories')
let User = require.main.require('./src/user')
let Topics = require.main.require('./src/topics')
let SocketAdmin = require.main.require('./src/socket.io/admin')
let db = require.main.require('./src/database')

let async = require.main.require('async')
let winston = require.main.require('winston')
let nconf = require.main.require('nconf')

let utils = require.main.require('./public/src/utils')

let version = '1.0.0'

exports.init = (params, next) => {
  winston.info('[sort-by-date] Loading sort by date...')

  params.router.get('/admin/plugins/category-sort-by-date', params.middleware.admin.buildHeader, renderAdmin)
  params.router.get('/api/admin/plugins/category-sort-by-date', renderAdmin)

  function renderAdmin (req, res, next) {
    res.render('admin/plugins/category-sort-by-date', {})
  }

  let getTopicIds = Categories.getTopicIds

  Categories.getTopicIds = function (cid, set, reverse, start, stop, callback) {
    if (!!set.match(/^cid:\d+:tids:lex$/)) {
      let pinnedTids, pinnedCount, totalPinnedCount
      let method, min, max

      if (reverse && !!db.getSortedSetRevRangeByLex) {
        method = 'getSortedSetRevRangeByLex'
        min = '+'
        max = '-'
      } else {
        method = 'getSortedSetRangeByLex'
        min = '-'
        max = '+'
      }

      async.waterfall([
        function (next) {
          Categories.getPinnedTids(cid, 0, -1, next)
        },
        function (_pinnedTids, next) {
          totalPinnedCount = _pinnedTids.length

          pinnedTids = _pinnedTids.slice(start, stop === -1 ? undefined : stop + 1)

          pinnedCount = pinnedTids.length

          let topicsPerPage = stop - start + 1

          let normalTidsToGet = Math.max(0, topicsPerPage - pinnedCount)

          if (!normalTidsToGet && stop !== -1) {
            return next(null, [])
          }
          if (start > 0 && totalPinnedCount) {
            start -= totalPinnedCount - pinnedCount
          }
          stop = stop === -1 ? stop : start + normalTidsToGet - 1

          if (Array.isArray(set)) {
            db[method](set[0], min, max, start, stop - start, next)
          } else {
            db[method](set, min, max, start, stop - start, next)
          }
        },
        function (topicValues, next) {
          let tids = []

          topicValues.forEach(function (value) {
            tid = value.split(':')
            tid = tid[tid.length - 1]
            tids.push(tid)
			  if (reverse) {
				  tids.sort(function (a, b) {
				  	return a - b;
				  })
			  } else {
				  tids.sort(function (a, b) {
				  	return b - a;
				  })
			  }
          })

          next(null, tids)

		  tids.sort(function (a, b) {  return a - b;  })

          db.isSetMembers('sortbydate:purged', tids, function (err, isMember) {
            for (let i = 0; i < topicValues.length; i++) {
              if (isMember[i]) {
                db.sortedSetRemove(set, topicValues[i])
                db.setRemove('sortbydate:purged', tids[i])
              }
            }
          })
        },
        function (normalTids, next) {
          normalTids = normalTids.filter(function (tid) {
            return pinnedTids.indexOf(tid) === -1;
          });

          next(null, pinnedTids.concat(normalTids));
        }
      ], callback);
    } else {
      getTopicIds(cid, set, reverse, start, stop, callback)
    }
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
      let keys = cids.map(function (cid) { return 'cid:' + cid + ':tids:lex' })

      db.deleteAll(keys, next)
    },
    async.apply(db.getSortedSetRange, 'topics:tid', 0, -1),
    function (tids, next) {
		tids.sort(function (a, b) {  return a - b;  })
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

exports.prepare = function (data, next) {
  User.getSettings(data.uid, function (err, settings) {
    if (settings.categoryTopicSort === 'a_z') {
		reindex()
        data.reverse = false
    }

    if (settings.categoryTopicSort === 'z_a') {
		reindex()
        data.reverse = true
    }

    next(null, data)
  })
}

exports.topicEdit = function (data, next) {
  let topic = data.topic

  Topics.getTopicField(topic.tid, 'title', function (err, title) {
    if (title !== topic.title) {
      let oldSlug = utils.slugify(title) || 'topic'

      db.sortedSetRemove('cid:' + topic.cid + ':tids:lex', oldSlug + ':' + topic.tid)
      db.sortedSetAdd('cid:' + topic.cid + ':tids:lex', 0, topic.title.split('/')[1] + ':' + topic.tid)
    }
	reindex()
    next(null, data)
  })
}

exports.topicPost = function (data) {
  let topic = data.topic

  db.sortedSetAdd('cid:' + topic.cid + ':tids:lex', 0, topic.title.split('/')[1] + ':' + topic.tid)
	reindex()
}

exports.topicPurge = function (data) {
  let tid = data.topic.tid

  db.setAdd('sortbydate:purged', tid)
	reindex()
}

exports.topicMove = function (topic) {
  Topics.getTopicField(topic.tid, 'slug', function (err, title) {
    db.sortedSetRemove('cid:' + topic.fromCid + ':tids:lex', title.split('/')[1] + ':' + topic.tid)
    db.sortedSetAdd('cid:' + topic.toCid + ':tids:lex', 0, title.split('/')[1] + ':' + topic.tid)
	reindex()
  })
}

exports.categoryDelete = function (data) {
  let cid = data.cid

  db.delete('cid:' + cid + ':tids:lex')
  reindex()
}

exports.adminBuild = (header, next) => {
  header.plugins.push({
    route : '/plugins/category-sort-by-date',
    icon  : 'fa-sort-alpha-asc',
    name  : 'Category Sort by Date'
  })

  next(null, header)
}
