# The deploy workflow runs `bundle install` and `bundle exec jekyll build`, and the
# README tells you to create this file by hand before serving locally. Neither
# worked: there was no Gemfile, so `bundle install` failed with "Could not locate
# Gemfile" (exit 10) on every push.
#
# Plain jekyll rather than the github-pages gem: nothing here needs a plugin, and
# github-pages pins Jekyll to an old version. If you ever switch Settings -> Pages
# to "Deploy from a branch" and let GitHub build the site itself, swap this for
# `gem "github-pages", group: :jekyll_plugins` — GitHub's own builder only allows
# its whitelisted plugin set.
source "https://rubygems.org"

gem "jekyll", "~> 4.3"

# Ruby 3 dropped webrick from the stdlib and `jekyll serve` needs it.
gem "webrick", "~> 1.8"
