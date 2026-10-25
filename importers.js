// Импорт плейлистов по ссылке: с чужих площадок берём только «исполнитель — название» и длительность,
// звук потом ищется на SoundCloud. Работает с публичными страницами без входа; закрытое не обходим.
// Страницы запрашивает sc.fetchText (main-процесс на ПК, CapacitorHttp на iPhone) — отсюда CORS закрыт.
const importers = (() => {
  const entities = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }
  const unescapeHtml = text => text.replace(/&(?:amp|quot|#x27|#39|lt|gt|nbsp);/g, m => entities[m])
  const meta = (html, property) => {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]*>`))?.[0]
    const content = tag?.match(/content="([^"]*)"/)?.[1]
    return content === undefined ? '' : unescapeHtml(content)
  }

  // Ссылка → { site, kind, id } или null. Для VK и плейлистов Яндекса возвращаем `closed`:
  // ссылка понятна, но список они без входа не отдают.
  function identify(link) {
    link = link.trim()
    const uri = link.match(/^spotify:(playlist|album):([A-Za-z0-9]+)$/)
    if (uri) return { site: 'spotify', kind: uri[1], id: uri[2] }
    let url
    try {
      url = new URL(link)
    } catch {
      return null
    }
    if (!/^https?:$/.test(url.protocol)) return null
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'open.spotify.com') {
      const match = url.pathname.match(/^\/(?:intl-[a-z]+\/)?(playlist|album)\/([A-Za-z0-9]+)/)
      return match && { site: 'spotify', kind: match[1], id: match[2] }
    }
    if (/^music\.yandex\.(ru|com|by|kz|uz)$/.test(host)) {
      const album = url.pathname.match(/^\/album\/(\d+)\/?$/)
      if (album) return { site: 'yandex', kind: 'album', id: album[1] }
      if (/^\/(?:users\/[^/]+\/)?playlists\//.test(url.pathname)) return { site: 'yandex', kind: 'playlist', closed: true }
      return null
    }
    if (/^(m\.)?vk\.(com|ru)$/.test(host)) return { site: 'vk', kind: 'playlist', closed: true }
    return null
  }

  const CLOSED = {
    vk: 'VK не отдаёт музыку без входа: страница плейлиста закрыта проверкой, а публичный API аудио закрыт с 2016 года. Обходить это не буду.',
    yandex: 'Яндекс без входа отдаёт в плейлисте только номера треков, без названий. Альбомы по ссылке работают, плейлисты — нет.',
  }

  function parseSpotify(html) {
    const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1]
    if (!raw) throw new Error('Spotify не отдал список треков')
    const entity = JSON.parse(raw).props?.pageProps?.state?.data?.entity
    if (!entity?.trackList) throw new Error('Spotify не отдал список треков: плейлист закрытый или удалён')
    const tracks = entity.trackList.map(t => ({
      title: t.title,
      artist: (t.subtitle ?? '').replace(/ /g, ' '),
      durationMs: t.duration || 0,
    }))
    return { title: entity.title, tracks }
  }

  // «PT4M49S» → миллисекунды.
  const isoDuration = value => {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '')
    return m ? ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000 : 0
  }

  // На странице альбома список треков лежит в разметке schema.org, а исполнитель — в og:description («Radiohead • Альбом • 2001»).
  function parseYandexAlbum(html) {
    const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
      .map(m => JSON.parse(m[1]))
      .find(d => d['@type'] === 'MusicAlbum')
    if (!ld?.tracks?.length) throw new Error('Яндекс не отдал список треков альбома')
    let artist = meta(html, 'og:description').split(' • ')[0].trim()
    if (/^(various artists|разные исполнители)$/i.test(artist)) artist = ''
    return {
      title: ld.name,
      tracks: ld.tracks.map(t => ({ title: t.name, artist, durationMs: isoDuration(t.duration) })),
    }
  }

  // Публичная страница встраивания отдаёт до 100 треков. Больше — только через официальный вход Spotify.
  async function loadSpotifyFull(id, spotifyCall) {
    const tracks = []
    let path = `/playlists/${id}/tracks?limit=100&fields=next,items(track(name,duration_ms,artists(name)))`
    while (path && tracks.length < 2000) {
      const page = await spotifyCall(path)
      for (const item of page.items) {
        if (item.track) tracks.push({ title: item.track.name, artist: item.track.artists.map(a => a.name).join(', '), durationMs: item.track.duration_ms })
      }
      path = page.next ? page.next.replace('https://api.spotify.com/v1', '') : ''
    }
    return tracks
  }

  // { title, tracks, note } или ошибка с понятным текстом.
  async function load(link, { fetchText, spotifyCall }) {
    const target = identify(link)
    if (!target) throw new Error('Не узнаю ссылку. Нужна ссылка на плейлист или альбом Spotify либо на альбом Яндекс Музыки')
    if (target.closed) throw new Error(CLOSED[target.site])
    if (target.site === 'spotify') {
      const list = parseSpotify(await fetchText(`https://open.spotify.com/embed/${target.kind}/${target.id}`))
      const capped = target.kind === 'playlist' && list.tracks.length >= 100
      if (capped && spotifyCall) {
        try {
          const full = await loadSpotifyFull(target.id, spotifyCall)
          if (full.length > list.tracks.length) return { ...list, tracks: full, note: '' }
        } catch {}
      }
      return { ...list, note: capped ? 'Spotify без входа отдаёт только первые 100 треков. Войди в Spotify в Настройках, чтобы забрать плейлист целиком.' : '' }
    }
    const list = parseYandexAlbum(await fetchText(`https://music.yandex.ru/album/${target.id}`))
    return { ...list, note: list.tracks.some(t => !t.artist) ? 'У альбома разные исполнители, поэтому ищу только по названию — возможны промахи.' : '' }
  }

  const normalize = text => text
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(?:feat|ft|featuring|prod)\b.*$/, ' ')
    .replace(/\s-\s.*\b(?:remaster(?:ed)?|version|mix|edit|live|mono|stereo|radio)\b.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  const has = (haystack, needle) => needle !== '' && ` ${haystack} `.includes(` ${needle} `)
  const words = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  // Слова, по которым узнаётся не оригинал. Проверяем по сырому названию: в скобках обычно и сидит «Remix».
  const VARIANT = /\b(?:remix|edit|flip|bootleg|rework|remake|tribute|pitched|cover|karaoke|instrumental|nightcore|slowed|sped|speed|reverb|8d|mashup|live|acoustic|arr|ensemble|soundfont|mix)\b/g
  const variants = text => new Set(text.toLowerCase().match(VARIANT))
  // Пометки в заливках, которые трек не меняют.
  const BENIGN = new Set(['official', 'audio', 'video', 'music', 'lyrics', 'lyric', 'hd', 'hq', 'free', 'download', 'clip', 'visualizer', 'explicit', 'remastered', 'remaster', 'full', 'song', 'single', 'new'])
  const splitArtists = artist => artist.split(/,|&| feat\.? | x /i).map(normalize).filter(Boolean)
  const mainArtist = artist => splitArtists(artist)[0] ?? ''

  // Запрос к поиску: «исполнитель название» без хвостов в скобках.
  const queryFor = entry => `${mainArtist(entry.artist)} ${normalize(entry.title)}`.trim()

  // Лучший кандидат или null. Если убрать из названия заливки имена исполнителей и пометки вроде «Official Audio»,
  // должно остаться ровно название трека; пояснения в скобках («Remix», «Bonnaroo 2012») допустимы, только если они есть и в оригинале.
  // Длительность — в пределах 20 с (у заливок на SoundCloud бывает +3–4 с, у расширенных версий — минуты).
  function bestMatch(entry, candidates) {
    const artists = splitArtists(entry.artist)
    const artistWords = new Set(artists.flatMap(a => a.split(' ')))
    const wantedWords = new Set(words(entry.title))
    // Номер дорожки в начале заливки («07 - Radiohead - …») название не меняет.
    const core = text => normalize(text).split(' ').filter((w, i) => !artistWords.has(w) && !BENIGN.has(w) && w !== 'by' && !(i === 0 && /^\d{1,2}$/.test(w) && !wantedWords.has(w))).join(' ')
    const wantedCore = core(entry.title)
    const wantedVariants = variants(entry.title)
    let best = null
    for (const track of candidates) {
      if (core(track.title) !== wantedCore) continue
      const extras = [...track.title.matchAll(/[(\[]([^)\]]*)[)\]]/g)].flatMap(m => words(m[1]))
      if (extras.some(w => !BENIGN.has(w) && !artistWords.has(w) && !wantedWords.has(w))) continue
      const credit = normalize(`${track.title} ${track.user?.username ?? ''} ${track.publisher_metadata?.artist ?? ''}`)
      if (artists.length && !artists.some(a => has(credit, a))) continue
      if ([...variants(`${track.title} ${track.user?.username ?? ''}`)].some(word => !wantedVariants.has(word))) continue
      const diff = entry.durationMs ? Math.abs(track.full_duration - entry.durationMs) : 0
      if (diff > 20000) continue
      const official = artists.some(a => has(normalize(track.user?.username ?? ''), a))
      const score = (diff <= 5000 ? 100 : 50 - diff / 1000) + (official ? 30 : 0) + (track.user?.verified ? 10 : 0) + Math.log10(1 + (track.playback_count ?? 0))
      if (!best || score > best.score) best = { track, score }
    }
    return best?.track ?? null
  }

  return { identify, load, queryFor, bestMatch }
})()

if (typeof module !== 'undefined') module.exports = importers
