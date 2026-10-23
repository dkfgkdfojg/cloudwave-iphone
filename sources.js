// Площадки кроме SoundCloud. Трек отсюда выглядит как трек SoundCloud (id, title, user, full_duration,
// media.transcodings), поэтому списки, очередь и плеер работают с ним без правок. Отличает его `source`:
// лайков, плейлистов, станций и скачивания у таких треков нет.
const EXTERNAL_TITLES = { audius: 'Audius', archive: 'Internet Archive', jamendo: 'Jamendo', spotify: 'Spotify' }

const sources = (() => {
  const APP = 'Cloudwave'
  const MP3 = { transcodings: [{ format: { protocol: 'progressive', mime_type: 'audio/mpeg' } }] }
  const getJson = async (url, what) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`${what} ответил ${res.status}`)
    return res.json()
  }
  // Адреса из чужих API идут в href и src: пропускаем только https, чтобы «javascript:» туда не попал.
  const https = url => (/^https:\/\//i.test(url) ? url : '')
  const external = (source, fields) => ({
    source,
    media: MP3,
    track_authorization: '',
    created_at: new Date().toISOString(),
    ...fields,
    artwork_url: https(fields.artwork_url),
    permalink_url: https(fields.permalink_url),
  })

  const audius = {
    async search(q) {
      const page = await getJson(`https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(q)}&limit=30&app_name=${APP}`, 'Audius')
      const tracks = page.data
        .filter(t => t.is_streamable && !t.is_delete && !t.is_unlisted && t.access?.stream !== false && !t.stream_conditions)
        .map(t => external('audius', {
          id: `audius:${t.id}`,
          title: t.title,
          user: { id: `audius:${t.user.id}`, username: t.user.name },
          artwork_url: t.artwork?.['480x480'],
          permalink_url: `https://audius.co${t.permalink}`,
          full_duration: t.duration * 1000,
          playback_count: t.play_count,
          likes_count: t.favorite_count,
          reposts_count: t.repost_count,
          genre: t.genre,
          created_at: t.created_at,
          streamUrl: `https://api.audius.co/v1/tracks/${t.id}/stream?app_name=${APP}`,
        }))
      return { tracks, total: tracks.length }
    },
    stream: track => ({ url: track.streamUrl, hls: false, preview: false }),
  }

  // Internet Archive отдаёт целиком записи, а не отдельные песни: берём первый MP3 из записи.
  const archive = {
    async search(q) {
      const query = `(${q}) AND mediatype:audio`
      const page = await getJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&fl[]=publicdate&rows=30&sort[]=downloads+desc&output=json`, 'Internet Archive')
      const one = value => (Array.isArray(value) ? value[0] : value)
      const tracks = page.response.docs.map(d => external('archive', {
        id: `archive:${d.identifier}`,
        title: one(d.title) ?? d.identifier,
        user: { id: `archive:${d.identifier}`, username: one(d.creator) ?? 'Internet Archive' },
        artwork_url: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
        permalink_url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
        full_duration: 0,
        playback_count: d.downloads,
        created_at: d.publicdate,
        identifier: d.identifier,
      }))
      return { tracks, total: page.response.numFound }
    },
    async stream(track) {
      const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(track.identifier)}`, 'Internet Archive')
      const files = (meta.files ?? []).filter(f => /mp3/i.test(f.format) && !f.private)
      const file = files.find(f => f.format === 'VBR MP3') ?? files[0]
      if (!file) throw new Error('В записи нет MP3')
      const length = Number(file.length)
      if (length > 0) track.full_duration = Math.round(length * 1000)
      const path = file.name.split('/').map(encodeURIComponent).join('/')
      return { url: `https://archive.org/download/${encodeURIComponent(track.identifier)}/${path}`, hls: false, preview: false }
    },
  }

  const jamendoKey = () => localStorage.getItem('jamendoKey') ?? ''
  const jamendo = {
    async search(q) {
      const params = new URLSearchParams({ client_id: jamendoKey(), format: 'json', limit: '30', search: q, audioformat: 'mp32', order: 'popularity_total' })
      const page = await getJson(`https://api.jamendo.com/v3.0/tracks/?${params}`, 'Jamendo')
      if (page.headers.status !== 'success') throw new Error(page.headers.error_message ?? 'Jamendo отказал')
      const tracks = page.results.filter(t => https(t.audio)).map(t => external('jamendo', {
        id: `jamendo:${t.id}`,
        title: t.name,
        user: { id: `jamendo:${t.artist_id}`, username: t.artist_name },
        artwork_url: t.image || t.album_image,
        permalink_url: t.shareurl,
        full_duration: t.duration * 1000,
        created_at: t.releasedate,
        streamUrl: t.audio,
      }))
      return { tracks, total: page.headers.results_fullcount ?? tracks.length }
    },
    stream: track => ({ url: track.streamUrl, hls: false, preview: false }),
  }

  // Spotify играет через Web Playback SDK (нужны Premium и Widevine), а не через <audio>: у плеера
  // приложения свой объект с теми же свойствами и событиями, что у аудио-элемента.
  const spotify = {
    ready: false,
    async search(q) {
      const page = await sc.spotify.call(`/search?q=${encodeURIComponent(q)}&type=track&limit=30`)
      const tracks = page.tracks.items.filter(t => t && t.is_playable !== false).map(t => external('spotify', {
        id: `spotify:${t.id}`,
        title: t.name,
        user: { id: `spotify:${t.artists[0]?.id}`, username: t.artists.map(a => a.name).join(', ') },
        artwork_url: (t.album.images[1] ?? t.album.images[0])?.url,
        permalink_url: t.external_urls.spotify,
        full_duration: t.duration_ms,
        playback_count: null,
        created_at: t.album.release_date,
        spotifyUri: t.uri,
      }))
      return { tracks, total: page.tracks.total }
    },
    stream: track => ({ spotifyUri: track.spotifyUri, hls: false, preview: false }),
    async refresh() {
      this.ready = Boolean(sc.spotify) && Boolean((await sc.spotify.status().catch(() => null))?.loggedIn)
      return this.ready
    },
  }

  const byId = { audius, archive, jamendo, spotify }
  // В приложении на iPhone звук ведёт нативный AVPlayer с загрузкой кусками под CDN SoundCloud (mobile/bridge.js):
  // чужие ссылки он не открывает, поэтому там остаётся один SoundCloud. Capacitor подключается позже этого файла.
  const choice = () => localStorage.getItem('searchSource') ?? 'soundcloud'

  return {
    audius,
    archive,
    jamendo,
    spotify,
    get supported() {
      return !window.Capacitor
    },
    jamendoKey,
    current() {
      const id = choice()
      return id === 'soundcloud' || this.available().some(s => s.id === id) ? id : 'soundcloud'
    },
    set: id => localStorage.setItem('searchSource', id),
    available() {
      if (!this.supported) return [{ id: 'soundcloud', label: 'SoundCloud' }]
      return [
        { id: 'soundcloud', label: 'SoundCloud' },
        { id: 'audius', label: EXTERNAL_TITLES.audius },
        { id: 'archive', label: EXTERNAL_TITLES.archive },
        ...(jamendoKey() ? [{ id: 'jamendo', label: EXTERNAL_TITLES.jamendo }] : []),
        ...(spotify.ready ? [{ id: 'spotify', label: EXTERNAL_TITLES.spotify }] : []),
      ]
    },
    search: (id, q) => byId[id].search(q),
    stream: track => byId[track.source].stream(track),
  }
})()

// Объект с интерфейсом аудио-элемента поверх Spotify Web Playback SDK. Играет только в Electron с Widevine.
const spotifyAudio = new (class extends EventTarget {
  uri = null
  paused = true
  duration = NaN
  #muted = false
  #volume = 1
  #base = 0
  #stamp = 0
  #player = null
  #connecting = null
  #deviceId = null
  #timer = 0
  #finished = false
  #started = false

  get volume() {
    return this.#volume
  }

  set volume(value) {
    this.#volume = value
    this.#applyVolume()
  }

  get muted() {
    return this.#muted
  }

  set muted(value) {
    this.#muted = value
    this.#applyVolume()
  }

  get currentTime() {
    const elapsed = this.paused ? 0 : (performance.now() - this.#stamp) / 1000
    const time = this.#base + elapsed
    return Number.isFinite(this.duration) ? Math.min(time, this.duration) : time
  }

  set currentTime(seconds) {
    this.#base = seconds
    this.#stamp = performance.now()
    this.dispatchEvent(new Event('timeupdate'))
    this.#player?.seek(seconds * 1000).then(() => this.dispatchEvent(new Event('seeked')))
  }

  getAttribute(name) {
    return name === 'src' ? this.uri : null
  }

  #applyVolume() {
    this.#player?.setVolume(this.#muted ? 0 : this.#volume)
    this.dispatchEvent(new Event('volumechange'))
  }

  #loadSdk() {
    if (window.Spotify) return Promise.resolve()
    return new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = resolve
      const script = document.createElement('script')
      script.src = 'https://sdk.scdn.co/spotify-player.js'
      script.onerror = () => reject(new Error('Не загрузился Spotify SDK'))
      document.head.append(script)
    })
  }

  #connect() {
    this.#connecting ??= (async () => {
      await this.#loadSdk()
      const player = new Spotify.Player({
        name: 'Cloudwave',
        volume: this.#muted ? 0 : this.#volume,
        getOAuthToken: give => sc.spotify.token().then(give, () => give('')),
      })
      const device = new Promise((resolve, reject) => {
        player.addListener('ready', ({ device_id }) => resolve(device_id))
        player.addListener('initialization_error', () => reject(new Error('Этот Electron не умеет играть Spotify (нет Widevine)')))
        player.addListener('authentication_error', () => reject(new Error('Spotify отклонил вход, войди заново в Настройках')))
        player.addListener('account_error', () => reject(new Error('Для Spotify в Cloudwave нужен Premium')))
      })
      // Ошибка входа приходит уже после connect(): без обработчика она падала бы необработанной.
      device.catch(() => {})
      player.addListener('playback_error', ({ message }) => this.#fail(message))
      player.addListener('player_state_changed', state => this.#onState(state))
      try {
        const connected = await player.connect()
        const silence = new Promise((_, reject) => setTimeout(() => reject(new Error('Spotify SDK не подключился')), connected ? 15000 : 3000))
        this.#deviceId = await Promise.race([device, silence])
      } catch (err) {
        player.disconnect()
        throw err
      }
      this.#player = player
    })().catch(err => {
      this.#connecting = null
      throw err
    })
    return this.#connecting
  }

  #fail(message) {
    this.#stopTimer()
    this.uri = null
    this.paused = true
    this.dispatchEvent(new Event('pause'))
    toast(`Spotify: ${message}`)
  }

  #startTimer() {
    this.#stopTimer()
    this.#timer = setInterval(() => this.dispatchEvent(new Event('timeupdate')), 250)
  }

  #stopTimer() {
    clearInterval(this.#timer)
    this.#timer = 0
  }

  #onState(state) {
    if (!state || !this.uri) return
    const { position, duration, paused, track_window: queue } = state
    const current = queue.current_track
    const ours = [current?.uri, current?.linked_from?.uri].includes(this.uri)
    // Конец трека SDK не сообщает: плеер встаёт на паузу в нуле, а сыгранный трек уходит в previous_tracks.
    // Пока трек ни разу не заиграл, такое состояние — просто загрузка (тот же трек включили повторно).
    const ended = this.#started && paused && position === 0 && queue.previous_tracks.some(t => [t.uri, t.linked_from?.uri].includes(this.uri))
    if (!ours && !ended) return
    if (ended) {
      if (this.#finished) return
      this.#finished = true
      this.#stopTimer()
      this.paused = true
      this.dispatchEvent(new Event('ended'))
      return
    }
    const wasPaused = this.paused
    if (!paused) this.#started = true
    this.#base = position / 1000
    this.#stamp = performance.now()
    this.paused = paused
    if (duration / 1000 !== this.duration) {
      this.duration = duration / 1000
      this.dispatchEvent(new Event('durationchange'))
    }
    if (wasPaused !== paused) {
      this.dispatchEvent(new Event(paused ? 'pause' : 'play'))
      if (paused) this.#stopTimer()
      else {
        this.#startTimer()
        this.dispatchEvent(new Event('playing'))
      }
    }
  }

  // Новый трек: SDK играет сам, плеер приложения только следит за его состоянием.
  async start(uri, startAt) {
    this.uri = uri
    this.#finished = false
    this.#started = false
    this.duration = NaN
    this.#base = startAt
    this.#stamp = performance.now()
    try {
      await this.#connect()
      if (this.uri !== uri) return
      await sc.spotify.call(`/me/player/play?device_id=${this.#deviceId}`, 'PUT', { uris: [uri], position_ms: Math.floor(startAt * 1000) })
    } catch (err) {
      if (this.uri === uri) this.#fail(err.message)
    }
  }

  play() {
    if (this.#player && this.uri) return this.#player.resume()
    return Promise.resolve()
  }

  pause() {
    this.#stopTimer()
    return this.#player?.pause() ?? Promise.resolve()
  }

  // Другой источник забирает плеер: Spotify замолкает и забывает трек.
  release() {
    if (!this.uri) return
    this.#player?.pause()
    this.#stopTimer()
    this.uri = null
    this.paused = true
  }
})()
