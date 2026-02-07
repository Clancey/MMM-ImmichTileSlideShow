// modules/MMM-ImmichTileSlideShow/immichApi.js
// Lightweight Immich API adapter with version negotiation and proxying

const Log = require('logger');
const axios = require('axios');
// http-proxy-middleware no longer used; custom routes stream with fallback

const LOG_PREFIX = 'MMM-ImmichTileSlideShow :: immichApi :: ';
const IMMICH_PROXY_URL = '/immichtilesslideshow/';
const IMMICH_VIDEO_PROXY_URL = '/immichtilesslideshow-video/';
const IMMICH_PREVIEW_PROXY_URL = '/immichtilesslideshow-preview/';

const immichApi = {
  debugOn: false,
  apiUrls: {
    v1_94: {
      albums: '/album',
      albumInfo: '/album/{id}',
      memoryLane: '/asset/memory-lane',
      assetInfo: '/asset/{id}',
      assetDownload: '/asset/file/{id}?isWeb=true',
      assetOriginal: '/asset/file/{id}',
      serverInfoUrl: '/server-info/version',
      search: 'NOT SUPPORTED',
      videoStream: '/asset/file/{id}?isWeb=true'
    },
    v1_106: {
      previousVersion: 'v1_94',
      albums: '/albums',
      albumInfo: '/albums/{id}',
      memoryLane: '/assets/memory-lane',
      assetInfo: '/assets/{id}',
      // Prefer preview, then thumbnail; keep original as fallback
      assetPreview: '/assets/{id}/thumbnail?size=preview',
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server-info/version',
      search: 'NOT SUPPORTED',
      // Use Immich's playback endpoint for transcoded video
      videoStream: '/assets/{id}/video/playback'
    },
    v1_118: {
      previousVersion: 'v1_106',
      albums: '/albums',
      albumInfo: '/albums/{id}',
      memoryLane: '/assets/memory-lane',
      assetInfo: '/assets/{id}',
      // Prefer preview, then thumbnail; keep original as fallback
      assetPreview: '/assets/{id}/thumbnail?size=preview',
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server/version',
      search: '/search/smart',
      // Use Immich's playback endpoint for transcoded video
      videoStream: '/assets/{id}/video/playback'
    },
    v1_133: {
      previousVersion: 'v1_118',
      albums: '/albums',
      albumInfo: '/albums/{id}',
      memoryLane: '/memories',
      assetInfo: '/assets/{id}',
      // Prefer preview, then thumbnail; keep original as fallback
      assetPreview: '/assets/{id}/thumbnail?size=preview',
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server/version',
      search: '/search/smart',
      randomSearch: '/search/random',
      // Use Immich's playback endpoint for transcoded video
      videoStream: '/assets/{id}/video/playback'
    }
  },

  apiLevel: 'v1_133',
  apiBaseUrl: '/api',
  http: null,
  preferThumbnail: false,

  /**
   * Initialize HTTP client and set up proxy route
   * @param {object} config - Immich config containing url, apiKey, timeout
   * @param {import('express').Express} expressApp
   * @param {boolean} force
   */
  init: async function (config, expressApp, force) {
    if (this.http === null || force) {
      this.preferThumbnail = !!config.preferThumbnail;
      this.http = axios.create({
        baseURL: config.url + this.apiBaseUrl,
        timeout: config.timeout || 6000,
        validateStatus: (status) => status >= 200 && status < 499,
        headers: {
          'x-api-key': config.apiKey,
          Accept: 'application/json'
        }
      });

      // Determine server version
      let serverVersion = { major: -1, minor: -1, patch: -1 };
      try {
        Log.debug(LOG_PREFIX + 'fetching server version...');
        let response = await this.http.get(this.apiUrls[this.apiLevel].serverInfoUrl, {
          responseType: 'json'
        });
        if (response.status === 200) {
          serverVersion = response.data;
        } else {
          let found = false;
          while (!found && !!this.apiUrls[this.apiLevel].previousVersion) {
            this.apiLevel = this.apiUrls[this.apiLevel].previousVersion;
            Log.debug(LOG_PREFIX + `retry server version (${this.apiLevel})...`);
            response = await this.http.get(this.apiUrls[this.apiLevel].serverInfoUrl, { responseType: 'json' });
            if (response.status === 200) {
              serverVersion = response.data;
              found = true;
            }
          }
          if (!found) Log.error(LOG_PREFIX + 'unexpected response from Immich', response.status, response.statusText);
        }
      } catch (e) {
        Log.error(LOG_PREFIX + 'Exception while fetching server version', e.message);
      }

      if (serverVersion.major > -1) {
        if (serverVersion.major === 1) {
          if (serverVersion.minor >= 106 && serverVersion.minor < 118) {
            this.apiLevel = 'v1_106';
          } else if (serverVersion.minor < 106) {
            this.apiLevel = 'v1_94';
          }
        }
      } else {
        throw new Error('Failed to get Immich version. Cannot proceed.');
      }

      // Image route with preview -> thumbnail -> original fallback (guard against duplicates)
      if (!this._imageProxySetup) {
        if (this.debugOn) Log.info(LOG_PREFIX + '[debug] setting up image route at ' + IMMICH_PROXY_URL);
        expressApp.get(IMMICH_PROXY_URL + ':id', async (req, res) => {
          const imageId = req.params.id;
          const urls = [];
          const conf = this.apiUrls[this.apiLevel];
          // Order of preference for images: when preferThumbnail=true, try smaller thumbnail first
          if (this.preferThumbnail) {
            if (conf.assetDownload) urls.push(conf.assetDownload.replace('{id}', imageId));
            if (conf.assetPreview) urls.push(conf.assetPreview.replace('{id}', imageId));
          } else {
            if (conf.assetPreview) urls.push(conf.assetPreview.replace('{id}', imageId));
            if (conf.assetDownload) urls.push(conf.assetDownload.replace('{id}', imageId));
          }
          if (conf.assetOriginal) urls.push(conf.assetOriginal.replace('{id}', imageId));
          for (let i = 0; i < urls.length; i++) {
            const p = urls[i];
            try {
              if (this.debugOn) Log.info(LOG_PREFIX + `[debug] image fetch try ${i + 1}/${urls.length}: ${p}`);
              const headers = { Accept: req.headers['accept'] || 'application/octet-stream' };
              if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
              if (req.headers['if-modified-since']) headers['If-Modified-Since'] = req.headers['if-modified-since'];
              const upstream = await this.http.get(p, { responseType: 'stream', headers });
              if ((upstream.status >= 200 && upstream.status < 300) || upstream.status === 304) {
                // Forward upstream headers and status
                for (const [k, v] of Object.entries(upstream.headers || {})) {
                  if (typeof v !== 'undefined' && v !== null) res.setHeader(k, v);
                }
                res.status(upstream.status);
                if (upstream.status === 304) { res.end(); return; }
                upstream.data.on('error', () => { try { res.end(); } catch (_) {} });
                upstream.data.pipe(res);
                return;
              }
              if (upstream.status === 404 && i < urls.length - 1) continue;
              res.status(upstream.status).end();
              return;
            } catch (e) {
              if (i < urls.length - 1) continue;
              Log.warn(LOG_PREFIX + 'image route error: ' + e.message);
              res.status(502).end();
              return;
            }
          }
        });
        this._imageProxySetup = true;
      }

      // Video route - only use transcoded stream (no fallback to original which may be unplayable)
      if (!this._videoProxySetup) {
        if (this.debugOn) Log.info(LOG_PREFIX + '[debug] setting up video route at ' + IMMICH_VIDEO_PROXY_URL);
        expressApp.get(IMMICH_VIDEO_PROXY_URL + ':id', async (req, res) => {
          const assetId = req.params.id;
          const urls = [];
          const conf = this.apiUrls[this.apiLevel];
          // Try transcoded stream first, fall back to original
          if (conf.videoStream) urls.push(conf.videoStream.replace('{id}', assetId));
          if (conf.assetOriginal) urls.push(conf.assetOriginal.replace('{id}', assetId));

          Log.info(LOG_PREFIX + `VIDEO REQUEST: ${assetId} | trying endpoints: ${urls.join(', ')}`);

          for (let i = 0; i < urls.length; i++) {
            const p = urls[i];
            Log.info(LOG_PREFIX + `VIDEO TRYING: ${assetId} | ${p}`);
            try {
              const headers = { Accept: req.headers['accept'] || '*/*' };
              if (req.headers['range']) headers['Range'] = req.headers['range'];
              if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
              if (req.headers['if-modified-since']) headers['If-Modified-Since'] = req.headers['if-modified-since'];
              if (this.debugOn) Log.info(LOG_PREFIX + `[debug] video fetch try ${i + 1}/${urls.length}: ${p}`);
              const upstream = await this.http.get(p, { responseType: 'stream', headers });
              if ((upstream.status >= 200 && upstream.status < 300) || upstream.status === 304) {
                const contentType = upstream.headers['content-type'] || 'unknown';
                const contentLength = upstream.headers['content-length'] || 'unknown';

                // Skip non-MP4 formats that won't play on Raspberry Pi / Chromium
                const unplayableFormats = ['video/quicktime', 'video/x-matroska', 'video/x-msvideo', 'video/webm'];
                if (unplayableFormats.includes(contentType)) {
                  Log.warn(LOG_PREFIX + `VIDEO SKIPPED: ${assetId} | type: ${contentType} (unplayable format, needs Immich transcoding)`);
                  // Try next URL (if any) or return 415 Unsupported Media Type
                  if (i < urls.length - 1) continue;
                  res.status(415).end();
                  return;
                }

                Log.info(LOG_PREFIX + `VIDEO SUCCESS: ${assetId} | type: ${contentType} | size: ${contentLength}`);

                for (const [k, v] of Object.entries(upstream.headers || {})) {
                  if (typeof v !== 'undefined' && v !== null) res.setHeader(k, v);
                }
                res.status(upstream.status);
                if (upstream.status === 304) { res.end(); return; }
                upstream.data.on('error', (err) => {
                  Log.error(LOG_PREFIX + `VIDEO STREAM ERROR: ${assetId} | ${err.message}`);
                  try { res.end(); } catch (_) {}
                });
                upstream.data.pipe(res);
                return;
              }
              Log.warn(LOG_PREFIX + `VIDEO FAILED: ${assetId} | status: ${upstream.status} (not transcoded yet?)`);
              if (upstream.status === 404 && i < urls.length - 1) continue;
              res.status(upstream.status).end();
              return;
            } catch (e) {
              Log.error(LOG_PREFIX + `VIDEO ERROR: ${assetId} | ${e.message}`);
              if (i < urls.length - 1) continue;
              res.status(502).end();
              return;
            }
          }
          Log.warn(LOG_PREFIX + `VIDEO NO SOURCE: ${assetId} | no transcoded stream available`);
          res.status(404).end();
        });
        this._videoProxySetup = true;
      }

      // Preview route - always returns preview or original (larger than thumbnail)
      if (!this._previewProxySetup) {
        if (this.debugOn) Log.info(LOG_PREFIX + '[debug] setting up preview route at ' + IMMICH_PREVIEW_PROXY_URL);
        expressApp.get(IMMICH_PREVIEW_PROXY_URL + ':id', async (req, res) => {
          const imageId = req.params.id;
          const urls = [];
          const conf = this.apiUrls[this.apiLevel];
          // Preview first, then original - skip thumbnail for full-size viewing
          if (conf.assetPreview) urls.push(conf.assetPreview.replace('{id}', imageId));
          if (conf.assetOriginal) urls.push(conf.assetOriginal.replace('{id}', imageId));
          for (let i = 0; i < urls.length; i++) {
            const p = urls[i];
            try {
              if (this.debugOn) Log.info(LOG_PREFIX + `[debug] preview fetch try ${i + 1}/${urls.length}: ${p}`);
              const headers = { Accept: req.headers['accept'] || 'application/octet-stream' };
              if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];
              if (req.headers['if-modified-since']) headers['If-Modified-Since'] = req.headers['if-modified-since'];
              const upstream = await this.http.get(p, { responseType: 'stream', headers });
              if ((upstream.status >= 200 && upstream.status < 300) || upstream.status === 304) {
                for (const [k, v] of Object.entries(upstream.headers || {})) {
                  if (typeof v !== 'undefined' && v !== null) res.setHeader(k, v);
                }
                res.status(upstream.status);
                if (upstream.status === 304) { res.end(); return; }
                upstream.data.on('error', () => { try { res.end(); } catch (_) {} });
                upstream.data.pipe(res);
                return;
              }
              if (upstream.status === 404 && i < urls.length - 1) continue;
              res.status(upstream.status).end();
              return;
            } catch (e) {
              if (i < urls.length - 1) continue;
              Log.warn(LOG_PREFIX + 'preview route error: ' + e.message);
              res.status(502).end();
              return;
            }
          }
        });
        this._previewProxySetup = true;
      }
      if (this.debugOn) Log.info(LOG_PREFIX + '[debug] Server API level -> ' + this.apiLevel);
      else Log.debug(LOG_PREFIX + 'Server API level -> ' + this.apiLevel);
    }
  },

  getAlbumNameToIdMap: async function () {
    const map = new Map();
    try {
      const response = await this.http.get(this.apiUrls[this.apiLevel].albums, { responseType: 'json' });
      if (response.status === 200) {
        if (this.debugOn) Log.info(LOG_PREFIX + `[debug] albums received: ${response.data.length}`);
        for (const album of response.data) {
          const name = album.albumName || album.name || album.title || (album['album_name']) || null;
          if (name) map.set(name, album.id);
        }
      } else {
        Log.error(LOG_PREFIX + 'unexpected response (albums)', response.status, response.statusText);
      }
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (albums)', e.message);
    }
    return map;
  },

  findAlbumIds: async function (albumNames) {
    const albumMap = await this.getAlbumNameToIdMap();
    let ids = [];
    for (const name of albumNames) {
      if (albumMap.has(name)) ids = ids.concat(albumMap.get(name));
      else Log.error(LOG_PREFIX + `no album named "${name}" (case sensitive)`);
    }
    return ids;
  },

  getAlbumAssets: async function (albumId) {
    let images = [];
    try {
      const response = await this.http.get(this.apiUrls[this.apiLevel].albumInfo.replace('{id}', albumId), { responseType: 'json' });
      if (response.status === 200) {
        images = [...response.data.assets];
        if (response.data.albumName) {
          images.forEach((img) => (img.albumName = response.data.albumName));
        }
        if (this.debugOn) Log.info(LOG_PREFIX + `[debug] album ${albumId} assets: ${images.length}`);
      } else {
        Log.error(LOG_PREFIX + 'unexpected response (albumInfo)', response.status, response.statusText);
      }
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (albumInfo)', e.message);
    }
    return images;
  },

  getAlbumAssetsForAlbumIds: async function (albumIds) {
    let images = [];
    for (const id of albumIds) {
      const current = await this.getAlbumAssets(id);
      if (current && current.length) images = images.concat(current);
    }
    return images;
  },

  getMemoryLaneAssets: async function (numDays) {
    let images = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 0; i < numDays; i++) {
      const params =
        this.apiLevel === 'v1_133'
          ? { for: today.toISOString(), type: 'on_this_day' }
          : { day: today.getDate(), month: today.getMonth() + 1 };
      try {
        const response = await this.http.get(this.apiUrls[this.apiLevel].memoryLane, { params, responseType: 'json' });
        if (response.status === 200) {
          response.data.forEach((m) => (images = m.assets.concat(images)));
          if (this.debugOn) Log.info(LOG_PREFIX + `[debug] memory lane day ${today.toISOString()} count: ${response.data.length}`);
        } else {
          Log.error(LOG_PREFIX + 'unexpected response (memoryLane)', response.status, response.statusText);
        }
      } catch (e) {
        Log.error(LOG_PREFIX + 'Exception (memoryLane)', e.message);
      }
      today.setDate(today.getDate() - 1);
    }
    return images;
  },

  searchAssets: async function (query, size) {
    let images = [];
    try {
      const body = { ...(query || {}), size: size || 100 };
      if (this.debugOn) Log.info(LOG_PREFIX + '[debug] search body ' + JSON.stringify(body));
      const response = await this.http.post(this.apiUrls[this.apiLevel].search, body, { responseType: 'json' });
      if (response.status === 200) images = response.data.assets?.items || response.data.items || response.data || [];
      else Log.error(LOG_PREFIX + 'unexpected response (search)', response.status, response.statusText);
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (search)', e.message);
    }
    return images;
  },

  randomSearchAssets: async function (size, query) {
    let images = [];
    try {
      const body = { size: size || 100, ...(query || {}) };
      if (this.debugOn) Log.info(LOG_PREFIX + '[debug] random body ' + JSON.stringify(body));
      const response = await this.http.post(this.apiUrls[this.apiLevel].randomSearch, body, { responseType: 'json' });
      if (response.status === 200) images = response.data || [];
      else Log.error(LOG_PREFIX + 'unexpected response (random)', response.status, response.statusText);
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (random)', e.message);
    }
    return images;
  },

  anniversarySearchAssets: async function (datesBack, datesForward, startYear, endYear, querySize, query) {
    let images = [];
    const today = new Date();
    const currentDay = today.getDate();
    try {
      const startDate = new Date(today);
      startDate.setDate(currentDay - datesBack);
      const endDate = new Date(today);
      endDate.setDate(currentDay + datesForward);
      const startMonth = startDate.getMonth();
      const startDay = startDate.getDate();
      const endMonth = endDate.getMonth();
      const endDay = endDate.getDate();

      for (let year = startYear; year <= endYear; year++) {
        let searchStartYear = year;
        let searchEndYear = year;
        if (startMonth > endMonth || (startMonth === endMonth && startDay > endDay)) searchEndYear = year + 1;

        const yStart = new Date(searchStartYear, startMonth, startDay);
        const yEnd = new Date(searchEndYear, endMonth, endDay);
        const body = {
          ...(query || {}),
          size: querySize || 100,
          takenAfter: yStart.toISOString().split('T')[0] + 'T00:00:00.000Z',
          takenBefore: yEnd.toISOString().split('T')[0] + 'T23:59:59.999Z'
        };
        try {
          const response = await this.http.post(this.apiUrls[this.apiLevel].randomSearch, body, { responseType: 'json' });
          if (response.status === 200) images = images.concat(response.data || []);
        } catch (e) {
          Log.warn(LOG_PREFIX + `anniversary year ${year} failed: ` + e.message);
        }
      }
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (anniversary)', e.message);
    }
    return images;
  },

  getAssetInfo: async function (imageId) {
    let assetInfo = { exifInfo: [], people: [] };
    try {
      const res = await this.http.get(this.apiUrls[this.apiLevel].assetInfo.replace('{id}', imageId), { responseType: 'json' });
      if (res.status === 200) {
        assetInfo.exifInfo = res.data.exifInfo || [];
        assetInfo.people = res.data.people || [];
      }
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (assetInfo)', e.message);
    }
    return assetInfo;
  },

  getBase64EncodedAsset: async function (imageId) {
    let base64Image = null;
    try {
      const bin = await this.http.get(this.apiUrls[this.apiLevel].assetDownload.replace('{id}', imageId), {
        headers: { Accept: 'application/octet-stream' },
        responseType: 'arraybuffer'
      });
      if (bin.status === 200) {
        const buf = Buffer.from(bin.data);
        base64Image = `data:${bin.headers['content-type']};base64, ` + buf.toString('base64');
      }
    } catch (e) {
      Log.error(LOG_PREFIX + 'Exception (asset blob)', e.message);
    }
    return base64Image;
  },

  getImageLink: function (imageId) {
    return IMMICH_PROXY_URL + imageId;
  },

  getVideoLink: function (imageId) {
    return IMMICH_VIDEO_PROXY_URL + imageId;
  }
};

module.exports = immichApi;
