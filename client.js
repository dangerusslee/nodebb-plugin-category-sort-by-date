$(window).on('action:ajaxify.end', function () {
  var sortEl = $('.category [component="thread/sort"] ul');
  sortEl.append('<li><a href="#" class="topics_oldest_to_newest" data-sort="topics_oldest_to_newest"><i class="fa fa-fw ' + (config.categoryTopicSort === 'topics_oldest_to_newest' ? 'fa-check' : '') + '"></i> Topics Newest to Oldest</a></li>');  
  sortEl.append('<li><a href="#" class="topics_newest_to_oldest" data-sort="topics_newest_to_oldest"><i class="fa fa-fw ' + (config.categoryTopicSort === 'topics_newest_to_oldest' ? 'fa-check' : '') + '"></i> Topics Oldest to Newest</a></li>');
});
