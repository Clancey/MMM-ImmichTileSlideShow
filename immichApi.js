// modules/MMM-ImmichTileSlideShow/immichApi.js
// Lightweight Immich API adapter with version negotiation and proxying

const Log = require('logger');
const axios = require('axios');
// http-proxy-middleware no longer used; custom routes stream with fallback

const LOG_PREFIX = 'MMM-ImmichTileSlideShow :: immichApi :: ';
const IMMICH_PROXY_URL = '/immichtilesslideshow/';
const IMMICH_VIDEO_PROXY_URL = '/immichtilesslideshow-video/';

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
      // Use smaller thumbnails to lighten browser load on low-power devices
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server-info/version',
      search: 'NOT SUPPORTED',
      // Use Immich's encoded video stream endpoint to reduce client load
      videoStream: '/assets/{id}/video'
    },
    v1_118: {
      previousVersion: 'v1_106',
      albums: '/albums',
      albumInfo: '/albums/{id}',
      memoryLane: '/assets/memory-lane',
      assetInfo: '/assets/{id}',
      // Use smaller thumbnails to lighten browser load on low-power devices
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server/version',
      search: '/search/smart',
      // Use Immich's encoded video stream endpoint to reduce client load
      videoStream: '/assets/{id}/video'
    },
    v1_133: {
      previousVersion: 'v1_118',
      albums: '/albums',
      albumInfo: '/albums/{id}',
      memoryLane: '/memories',
      assetInfo: '/assets/{id}',
      // Use smaller thumbnails to lighten browser load on low-power devices
      assetDownload: '/assets/{id}/thumbnail?size=thumbnail',
      assetOriginal: '/assets/{id}/original',
      serverInfoUrl: '/server/version',
      search: '/search/smart',
      randomSearch: '/search/random',
      // Use Immich's encoded video stream endpoint to reduce client load
      videoStream: '/assets/{id}/video'
    }
  },

  apiLevel: 'v1_133',
  apiBaseUrl: '/api',
  http: null,

  /**
   * Initialize HTTP client and set up proxy route
   * @param {object} config - Immich config containing url, apiKey, timeout
   * @param {import('express').Express} expressApp
   * @param {boolean} force
   */
  init: async function (config, expressApp, force) {
    if (this.http === null || force) {
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

      // Image route with fallback to original on 404 (guard against duplicates)
      if (!this._imageProxySetup) {
        if (this.debugOn) Log.info(LOG_PREFIX + '[debug] setting up image route at ' + IMMICH_PROXY_URL);
        expressApp.get(IMMICH_PROXY_URL + ':id', async (req, res) => {
          const imageId = req.params.id;
          const paths = [
            this.apiUrls[this.apiLevel].assetDownload.replace('{id}', imageId),
            this.apiUrls[this.apiLevel].assetOriginal.replace('{id}', imageId)
          ];
          for (let i = 0; i < paths.length; i++) {
            const p = this.apiBaseUrl + paths[i];
            try {
              const upstream = await this.http.get(p, { responseType: 'stream', headers: { Accept: 'application/octet-stream' } });
              if (upstream.status === 200) {
                const ct = upstream.headers['content-type']; if (ct) res.setHeader('Content-Type', ct);
                const cl = upstream.headers['content-length']; if (cl) res.setHeader('Content-Length', cl);
                res.setHeader('Cache-Control', 'public, max-age=600');
                upstream.data.on('error', () => { try { res.end(); } catch (_) {} });
                upstream.data.pipe(res);
                return;
              }
              if (upstream.status === 404 && i < paths.length - 1) continue;
              res.status(upstream.status).end();
              return;
            } catch (e) {
              if (i < paths.length - 1) continue;
              Log.warn(LOG_PREFIX + 'image route error: ' + e.message);
              res.status(502).end();
              return;
            }
          }
        });
        this._imageProxySetup = true;
      }

      // Video route with fallback to original on 404
      if (!this._videoProxySetup) {
        if (this.debugOn) Log.info(LOG_PREFIX + '[debug] setting up video route at ' + IMMICH_VIDEO_PROXY_URL);
        expressApp.get(IMMICH_VIDEO_PROXY_URL + ':id', async (req, res) => {
          const assetId = req.params.id;
          const paths = [
            this.apiUrls[this.apiLevel].videoStream.replace('{id}', assetId),
            this.apiUrls[this.apiLevel].assetOriginal.replace('{id}', assetId)
          ];
          for (let i = 0; i < paths.length; i++) {
            const p = this.apiBaseUrl + paths[i];
            try {
              const upstream = await this.http.get(p, { responseType: 'stream', headers: { Accept: '*/*' } });
              if (upstream.status === 200) {
                const ct = upstream.headers['content-type']; if (ct) res.setHeader('Content-Type', ct);
                const cl = upstream.headers['content-length']; if (cl) res.setHeader('Content-Length', cl);
                res.setHeader('Cache-Control', 'public, max-age=600');
                upstream.data.on('error', () => { try { res.end(); } catch (_) {} });
                upstream.data.pipe(res);
                return;
              }
              if (upstream.status === 404 && i < paths.length - 1) continue;
              res.status(upstream.status).end();
              return;
            } catch (e) {
              if (i < paths.length - 1) continue;
              Log.warn(LOG_PREFIX + 'video route error: ' + e.message);
              res.status(502).end();
              return;
            }
          }
        });
        this._videoProxySetup = true;
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
