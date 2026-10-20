"use strict";

// How this page is being served. "local" is src/web/serve.py on this computer,
// the only server that answers live scores and Kadro Kur recommendations.
// "published" is the files-only copy src/web/build_static.py writes for the
// public site; the build rewrites SITE_PUBLISHED below. "none" is index.html
// opened from disk, which has no saved data to read.
const SITE_PUBLISHED = false;
const siteMode = SITE_PUBLISHED ? "published"
  : location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname) ? "local" : "none";
