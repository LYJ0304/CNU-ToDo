/* ───────────── 1. 의존성 ───────────── */
const express       = require('express');
const path          = require('path');
const webpush       = require('web-push');
const axios         = require('axios');
const cheerio       = require('cheerio');
const storage       = require('node-persist');
const fs            = require('fs').promises; // 비동기 파일 시스템 작업을 위해 추가
const os            = require('os');
const logger        = require('./logger'); // 로깅 모듈 추가
const gaServer      = require('./ga-server'); // 구글 애널리틱스 모듈 추가

/* ───────────── 2. 상수 ───────────── */
const PORT = process.env.PORT || 8080;
const BLOCK_SIZE_MS      = 3 * 60 * 60 * 1000;   // 3시간
const BLOCK_LEAD_TIME_MS = 5 * 60 * 1000;        // 5분
const MAX_DELAY          = 2_147_483_647;        // setTimeout 한계 ≈24.8일

/* ───────────── 3. 전역 메모리 ───────────── */
let subscriptions    = [];            // [{endpoint, keys, ...}, ...]
const scheduledLoaders = {};          // key(block) → [timeoutId,...]

// 간편 로그 함수 참조 (logger 모듈에서 가져옴)
const log = logger.log;

/* ───────────── 4. 헬퍼 ───────────── */
function scheduleAt(targetTime, fn) {
  const delay = targetTime - Date.now();
  
  // 이미 지난 시간이거나 500ms 미만의 짧은 지연은 
  // 즉시 실행하지만 최소한 10ms 지연시켜 콜 스택이 비워지도록 함
  if (delay <= 500) {
    // console.log 대신 async 함수 호출 문제로 인해 즉시 실행 로그는 유지
    console.log(`매우 짧은 지연(${delay}ms)으로 알림 예약됨: ${new Date(targetTime).toISOString()}`);
    return setTimeout(fn, Math.max(10, delay));
  } else if (delay > MAX_DELAY) {
    // 타이머 최대 지연 제한 넘어가는 경우 연쇄 타이머 설정
    const chainTimerId = setTimeout(() => {
      const nextTimerId = scheduleAt(targetTime, fn);
      // 연쇄 타이머 ID 저장을 위한 로직을 여기에 추가할 수 있음
    }, MAX_DELAY);
    return chainTimerId;
  } else {
    return setTimeout(fn, delay);
  }
}

function sendPush(subscription, message) {
  const payload = JSON.stringify({
    title  : '사이버캠퍼스 일정을 확인해보세요!',
    message
  });
  webpush
    .sendNotification(subscription, payload)
    .catch(async err => {
      await log.error('푸시 전송 실패', err);
      
      // 구독이 만료되었거나 존재하지 않는 경우(410 Gone 또는 404 Not Found)
      if (err.statusCode === 410 || err.statusCode === 404) {
        await log.info(`만료된 구독 발견(${err.statusCode}), 제거 중: ${subscription.endpoint}`);
        
        // 구독 제거
        subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
        await storage.setItem('subscriptions', subscriptions);
        
        // 해당 endpoint의 모든 알림 파일 찾기 및 삭제
        const endpointEnc = encodeURIComponent(subscription.endpoint);
        const alarmFiles = await findEndpointAlarms(endpointEnc);
        
        for (const filePath of alarmFiles) {
          await fs.unlink(filePath).catch(() => {});
        }
        
        // 관련 타이머 제거
        for (const key in scheduledLoaders) {
          if (key.includes(endpointEnc)) {
            scheduledLoaders[key].forEach(id => clearTimeout(id));
            delete scheduledLoaders[key];
          }
        }
        
        await log.info(`구독 제거 완료: ${subscription.endpoint}`);
      }
    });
}

/* ───────────── 캐시 관리 헬퍼 함수 추가 ───────────── */
const CACHE_BASE_DIR = path.join(__dirname, 'cache');

// 날짜/시간 폴더 경로 생성 함수
async function getTimeFolderPath(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  
  const dateFolder = `${year}-${month}-${day}`;
  const hourFolder = hour;
  
  const datePath = path.join(CACHE_BASE_DIR, dateFolder);
  const hourPath = path.join(datePath, hourFolder);
  
  // 필요한 디렉토리 생성
  try {
    await fs.mkdir(datePath, { recursive: true });
    await fs.mkdir(hourPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  
  return hourPath;
}

// 알림 저장 함수
async function saveAlarm(subscription, alarm) {
  const endpointEnc = encodeURIComponent(subscription.endpoint);
  const ts = Number(alarm.scheduledTime);
  const blockStart = ts - (ts % BLOCK_SIZE_MS);
  const filename = `${endpointEnc}-${blockStart}.json`;
  
  const folderPath = await getTimeFolderPath(ts);
  const filePath = path.join(folderPath, filename);
  
  // 파일 저장
  await fs.writeFile(filePath, JSON.stringify(alarm), 'utf8');
  return { filePath, blockStart };
}

// 알림 로드 함수
async function loadAlarm(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// 특정 엔드포인트의 모든 알림 파일 찾기
async function findEndpointAlarms(endpointEnc) {
  const results = [];
  
  // 모든 날짜 폴더 순회
  const dateFolders = await fs.readdir(CACHE_BASE_DIR);
  for (const dateFolder of dateFolders) {
    if (!dateFolder.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
    
    const datePath = path.join(CACHE_BASE_DIR, dateFolder);
    const hourFolders = await fs.readdir(datePath);
    
    // 각 시간 폴더 순회
    for (const hourFolder of hourFolders) {
      if (!hourFolder.match(/^\d{2}$/)) continue;
      
      const hourPath = path.join(datePath, hourFolder);
      const files = await fs.readdir(hourPath);
      
      // 해당 엔드포인트의 파일만 필터링
      const matchingFiles = files.filter(f => f.startsWith(`${endpointEnc}-`));
      matchingFiles.forEach(f => {
        results.push(path.join(hourPath, f));
      });
    }
  }
  
  return results;
}

// 오래된 캐시 정리 함수
async function cleanupOldCache() {
  const now = Date.now();
  const dateFolders = await fs.readdir(CACHE_BASE_DIR);
  
  for (const dateFolder of dateFolders) {
    if (!dateFolder.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
    
    const [year, month, day] = dateFolder.split('-').map(Number);
    const folderDate = new Date(year, month - 1, day);
    
    // 30일 이상 지난 폴더 삭제
    if (now - folderDate.getTime() > 30 * 24 * 60 * 60 * 1000) {
      await fs.rm(path.join(CACHE_BASE_DIR, dateFolder), { recursive: true, force: true });
    }
  }
}

/* ───────────── 5. storage 초기화 & 복원 수정 ───────────── */
(async () => {
  await storage.init({
    dir: path.join(__dirname, 'storage'), // 구독 정보용 별도 폴더
    forgiveParseErrors: true
  });

  // 로깅 시스템 초기화
  await logger.initializeLogger();
  
  // 구글 애널리틱스 초기화
  const gaInitialized = gaServer.init();
  await logger.log.info(`구글 애널리틱스 초기화: ${gaInitialized ? '성공' : '비활성화'}`);

  // 구독 복원
  try {
    const savedSubs = await storage.getItem('subscriptions');
    if (Array.isArray(savedSubs)) subscriptions = savedSubs;
  } catch (err) {
    console.error('구독 복원 실패:', err);
    subscriptions = [];
  }
  
  // 오래된 캐시 정리
  await cleanupOldCache();
  
  // 향후 예정된 알림 복원 및 스케줄링
  const now = Date.now();
  for (const sub of subscriptions) {
    const endpointEnc = encodeURIComponent(sub.endpoint);
    const alarmFiles = await findEndpointAlarms(endpointEnc);
    
    for (const filePath of alarmFiles) {
      const alarm = await loadAlarm(filePath);
      if (!alarm) continue;
      
      const ts = Number(alarm.scheduledTime);
      const blockStart = ts - (ts % BLOCK_SIZE_MS);
      const loaderTime = blockStart - BLOCK_LEAD_TIME_MS;
      
      // 이미 지난 시간이면 스킵
      if (ts < now) {
        await fs.unlink(filePath).catch(() => {});
        continue;
      }
      
      // 로더 시간이 이미 지났으면 즉시 스케줄링
      if (now >= loaderTime) {
        scheduleAt(ts, () => sendPush(sub, alarm.message));
        await fs.unlink(filePath).catch(() => {});
      } else {
        // 로더 시간에 알림 로드하도록 스케줄링
        const id = scheduleAt(loaderTime, async () => {
          const loadedAlarm = await loadAlarm(filePath);
          if (loadedAlarm) {
            scheduleAt(ts, () => sendPush(sub, loadedAlarm.message));
            await fs.unlink(filePath).catch(() => {});
          }
        });
        
        const key = `loader-${blockStart}`;
        scheduledLoaders[key] = scheduledLoaders[key] || [];
        scheduledLoaders[key].push(id);
      }
    }
  }
})();

/* ───────────── 6. Express 설정 ───────────── */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ───────────── 신규: 사용자 액션 로그 API ───────────── */
app.post('/log/user_action', async (req, res) => {
  try {
    const logData = req.body;
    
    // 기본 유효성 검사
    if (!logData || !logData.action) {
      return res.status(400).json({ error: 'invalid_log_data' });
    }
    
    // 클라이언트 IP 추가 (개인정보 보호를 위해 마지막 옥텟 제거)
    const clientIp = req.ip || req.connection.remoteAddress || '';
    if (clientIp) {
      const ipParts = clientIp.split('.');
      if (ipParts.length === 4) {
        ipParts[3] = 'xxx';
        logData.anonymized_ip = ipParts.join('.');
      } else {
        logData.anonymized_ip = clientIp;
      }
    }
    
    // 로그 저장
    const saved = await logger.saveUserActionLog(logData);
    
    // 구글 애널리틱스로 이벤트 전송
    if (saved && logData.action) {
      gaServer.trackEvent(logData.action, logData.details || {}, logData.sessionId);
    }
    
    // 응답 반환 (이미 클라이언트에 응답했을 수 있으므로 검사)
    if (!res.headersSent) {
      res.status(saved ? 200 : 500).json({ 
        success: saved, 
        message: saved ? 'Log saved' : 'Failed to save log' 
      });
    }
  } catch (err) {
    console.error('사용자 액션 로그 처리 오류:', err);
    
    // 응답이 아직 전송되지 않았으면 오류 응답
    if (!res.headersSent) {
      res.status(500).json({ error: 'log_processing_error' });
    }
  }
});

// 로그 통계 API (관리자용)
app.get('/admin/log-stats', async (req, res) => {
  try {
    // 실제 서비스에서는 관리자 인증 추가
    // if (!isAdmin(req)) return res.status(403).json({ error: 'unauthorized' });
    
    const stats = await logger.generateLogStats();
    if (stats) {
      res.json(stats);
    } else {
      res.status(500).json({ error: 'Failed to generate log stats' });
    }
  } catch (err) {
    console.error('로그 통계 API 오류:', err);
    res.status(500).json({ error: 'log_stats_error' });
  }
});

/* ───────────── 7. VAPID 키 ───────────── */
// 실제 서비스라면 환경 변수로
const vapidKeys = {
  publicKey:'BOhDx6qmgOFoN0-TUSvl2KCC56XUIXY3svPqnfuSfMwLKDuspLNlnaSih8RTsDaAhyTe_C57QOzQ8Sm32cYrdUQ',
  privateKey: 'RxNkiWr76ZcDTNfd5FUq51V7ZhIi9jSaXYBSiRrFSDc'
};
webpush.setVapidDetails('mailto:example@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

/* ───────────── 8. 구독 관리 ───────────── */
app.post('/subscribe', async (req, res) => {
  const sub = req.body;
  const idx = subscriptions.findIndex(s => s.endpoint === sub.endpoint);
  if (idx !== -1) subscriptions[idx] = sub;
  else subscriptions.push(sub);
  await storage.setItem('subscriptions', subscriptions);
  
  // 구독 이벤트 GA 전송
  gaServer.trackEvent('notification_subscribed', {
    subscription_count: subscriptions.length
  });
  
  res.sendStatus(200);
});

app.post('/unsubscribe', async (req, res) => {
  const sub = req.body;
  const endpointEnc = encodeURIComponent(sub.endpoint);
  
  // 1. 구독자 목록에서 제거
  subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
  await storage.setItem('subscriptions', subscriptions);
  
  // GA 이벤트 전송
  gaServer.trackEvent('notification_unsubscribed', {
    subscription_count: subscriptions.length
  });
  
  // 2. 해당 엔드포인트의 모든 알림 파일 찾아서 삭제
  const existingFiles = await findEndpointAlarms(endpointEnc);
  await log.info(`구독 해제: ${sub.endpoint} - ${existingFiles.length}개 알림 파일 삭제 중`);
  
  for (const filePath of existingFiles) {
    await fs.unlink(filePath).catch(err => {
      log.error(`알림 파일 삭제 실패: ${filePath}`, err);
    });
  }
  
  // 3. 메모리에 있는 타이머 정리 (prefix 수정: 'alarms-' → 'loader-')
  for (const key in scheduledLoaders) {
    if (key.includes(endpointEnc)) {
      await log.info(`타이머 정리: ${key}`);
      scheduledLoaders[key].forEach(id => clearTimeout(id));
      delete scheduledLoaders[key];
    }
  }
  
  await log.info(`구독 해제 완료: ${sub.endpoint}`);
  res.status(200).json({ success: true, message: '알림 구독이 해제되었습니다.' });
});

/* ───────────── 9. 알림 예약 API 수정 ───────────── */
app.post('/scheduleNotification', async (req, res) => {
  const { subscription, push_alarms } = req.body;
  if (!subscription || !push_alarms) {
    return res.status(400).json({ error: 'bad_request' });
  }

  // 처리 중 플래그 - 동일 엔드포인트에 대한 중복 처리 방지
  const endpointEnc = encodeURIComponent(subscription.endpoint);
  const processingKey = `processing-${endpointEnc}`;
  
  // 이미 처리 중인지 확인
  if (global[processingKey]) {
    await log.warn(`알림 예약 중복 요청 감지: ${endpointEnc} - 처리 대기`);
    // 처리가 완료될 때까지 잠시 대기 (최대 3초)
    let waitCount = 0;
    while (global[processingKey] && waitCount < 30) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
    }
    
    // 여전히 처리 중이면 이전 요청이 완료되도록 함
    if (global[processingKey]) {
      await log.warn(`알림 예약 중복 요청 타임아웃: ${endpointEnc}`);
      return res.status(409).json({ 
        error: 'concurrent_request', 
        message: '알림 처리 중입니다. 잠시 후 다시 시도해주세요.' 
      });
    }
  }
  
  // 처리 시작 플래그 설정
  global[processingKey] = true;
  
  try {
    /* ❶ 기존 알림 파일 및 타이머 제거 (동기적으로 완료) */
    const existingFiles = await findEndpointAlarms(endpointEnc);
    await log.info(`기존 알림 파일 ${existingFiles.length}개 제거 중 - ${endpointEnc}`);
    
    // 파일 삭제를 Promise.all로 병렬 처리하되 모두 완료될 때까지 대기
    await Promise.all(existingFiles.map(filePath => fs.unlink(filePath).catch(() => {})));
  
    // 메모리 로더 타이머 정리
    const timersToRemove = [];
  for (const key in scheduledLoaders) {
    if (key.includes(endpointEnc)) {
        timersToRemove.push(key);
      scheduledLoaders[key].forEach(id => clearTimeout(id));
    }
  }
    
    // 타이머 목록에서 삭제
    timersToRemove.forEach(key => delete scheduledLoaders[key]);

  /* ❷ 새 알림 저장 & 스케줄링 */
  const now = Date.now();
  const results = [];
    const processedTimes = new Set(); // 이미 처리된 시간 추적

  for (const alarm of push_alarms) {
    const ts = Number(alarm.scheduledTime);
      
      // 너무 가까운 시간의 중복 알림 방지 (동일 시간 또는 1분 이내)
      const timeKey = Math.floor(ts / 60000); // 분 단위로 그룹화
      if (processedTimes.has(timeKey)) {
        await log.info(`중복 시간 알림 스킵: ${new Date(ts).toISOString()}`);
        continue;
      }
      processedTimes.add(timeKey);
      
    const blockStart = ts - (ts % BLOCK_SIZE_MS);
    const loaderTime = blockStart - BLOCK_LEAD_TIME_MS;
    
      // 이미 로더 시간이 지났거나 30초 이내에 도래하는 경우 즉시 스케줄링
      const isImminent = (now + 30000) >= loaderTime;
      
      if (isImminent) {
        await log.info(`즉시 스케줄링 - 시간: ${new Date(ts).toISOString()}`);
        // 직접 알림 시간에 타이머 등록 (로더 단계 건너뜀)
        const timerId = scheduleAt(ts, () => sendPush(subscription, alarm.message));
        
        // 타이머 ID를 별도 관리 (loader가 아닌 direct- 접두사 사용)
        const directKey = `direct-${endpointEnc}-${ts}`;
        scheduledLoaders[directKey] = [timerId];
        
        results.push({ 
          scheduled: true, 
          time: new Date(ts).toISOString(),
          type: 'immediate' 
        });
      continue;
    }
    
      // 나중에 예약될 알림은 파일로 저장
      try {
    const { filePath } = await saveAlarm(subscription, alarm);
    
        // 로더 타이머 등록 (아직 등록된 타이머가 없는 경우만)
    const key = `loader-${blockStart}`;
    if (!scheduledLoaders[key]) {
          await log.info(`로더 타이머 등록 - 블록 ${blockStart}, 로더 시간: ${new Date(loaderTime).toISOString()}`);
      const id = scheduleAt(loaderTime, async () => {
        const loadedAlarm = await loadAlarm(filePath);
        if (loadedAlarm) {
              const alarmTime = Number(loadedAlarm.scheduledTime);
              await log.info(`알림 로드 및 스케줄링: ${new Date(alarmTime).toISOString()}`);
              scheduleAt(alarmTime, () => sendPush(subscription, loadedAlarm.message));
              await fs.unlink(filePath).catch(e => log.error('알림 파일 삭제 실패', e));
        }
      });
      
      scheduledLoaders[key] = [id];
    }
    
        results.push({ 
          scheduled: true, 
          time: new Date(ts).toISOString(),
          type: 'scheduled' 
        });
      } catch (err) {
        await log.error(`알림 저장 실패`, err);
        results.push({ 
          scheduled: false, 
          time: new Date(ts).toISOString(),
          error: err.message
        });
      }

    // 알림 예약 이벤트 GA 전송
    gaServer.trackEvent('notification_scheduled', {
      time: new Date(ts).toISOString(),
      type: alarm.type || 'daily'
    }, endpointEnc);
  }

  res.json({ ok: true, results });
  } catch (error) {
    await log.error('알림 스케줄링 오류', error);
    res.status(500).json({ error: 'scheduling_error', message: error.message });
  } finally {
    // 항상 처리 플래그 해제
    global[processingKey] = false;
    setTimeout(() => {
      // 10초 후 메모리에서 완전히 제거 (GC 도움)
      delete global[processingKey];
    }, 10000);
  }
});

/* ───────────── 10. 블록 로드 함수 ───────────── */
async function loadBlockAndSchedule(key, endpointEnc) {
  const list = (await storage.getItem(key)) || [];
  if (!list.length) return;
  // 대응 구독 객체 찾기
  const sub = subscriptions.find(s => encodeURIComponent(s.endpoint) === endpointEnc);
  if (!sub) return;

  for (const a of list) {
    scheduleAt(Number(a.scheduledTime), () => sendPush(sub, a.message));
  }
  await storage.removeItem(key);
}

/* ───────────── 11. 학사일정 API (이전과 동일) ───────────── */
async function crawlCalendar(year) {
  const url =
    `https://plus.cnu.ac.kr/_prog/academic_calendar/?site_dvs_cd=kr&menu_dvs_cd=05020101&year=${year}`;
  const { data: html } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Node.js)' } });
  const $ = cheerio.load(html);
  const tmp = [];
  $('.calen_box').each((_, box) => {
    const monthKr = $(box).find('.fl_month strong').text().trim();
    const monthEn = $(box)
      .find('.fl_month')
      .text()
      .replace(monthKr, '')
      .trim()
      .split(/\s+/)[0];
    const events = [];
    $(box)
      .find('ul > li')
      .each((_, li) => {
        const period = $(li).find('strong').text().trim();
        const title = $(li).find('span.list').text().trim();
        if (period && title) events.push({ date: period, title });
      });
    tmp.push({ monthKr, monthEn, events });
  });
  const dedup = [], seen = new Set();
  for (let i = tmp.length - 1; i >= 0; i--) {
    const m = parseInt(tmp[i].monthKr, 10);
    if (!seen.has(m)) {
      seen.add(m);
      dedup.unshift(tmp[i]);
    }
  }
  return dedup;
}

app.get('/api/calendar', async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const key = `cal-${year}`;
  const cached = await storage.getItem(key);
  if (cached) return res.json(cached);
  try {
    const data = await crawlCalendar(year);
    await storage.setItem(key, data);
    res.json(data);
  } catch (e) {
    console.error('calendar crawl error:', e);
    res.status(500).json({ error: 'crawl_failed' });
  }
});

/* ───────────── 12. SPA fallback ───────────── */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/cnutodo_client.html')));

/* ───────────── 추가: 구글 애널리틱스 관리자 API ───────────── */
// 관리자 인증 미들웨어 (기본 인증)
function basicAuth(req, res, next) {
  // 환경변수에서 인증 정보 가져오기
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  
  // 관리자 인증 정보가 설정되어 있지 않으면 401 반환
  if (!adminUser || !adminPass) {
    logger.log.warn('관리자 인증 정보가 설정되지 않음');
    return res.status(401).json({ error: 'Authentication not configured' });
  }
  
  // 요청 헤더에서 Authorization 정보 추출
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Basic Auth 디코딩
  try {
    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];
    
    if (user === adminUser && pass === adminPass) {
      return next();
    }
  } catch (err) {
    logger.log.error('인증 처리 오류', err);
  }
  
  res.setHeader('WWW-Authenticate', 'Basic');
  return res.status(401).json({ error: 'Invalid credentials' });
}

// 일일 사용자 통계 API
app.get('/admin/analytics/daily-users', basicAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await gaServer.analytics.getDailyActiveUsers(days);
    res.json(data || { error: 'Analytics data not available' });
  } catch (err) {
    await logger.log.error('일일 사용자 통계 API 오류', err);
    res.status(500).json({ error: 'Failed to retrieve analytics data' });
  }
});

// 총 설치 수 API
app.get('/admin/analytics/installations', basicAuth, async (req, res) => {
  try {
    const data = await gaServer.analytics.getTotalInstallations();
    res.json({ installations: data });
  } catch (err) {
    await logger.log.error('설치 수 통계 API 오류', err);
    res.status(500).json({ error: 'Failed to retrieve installation data' });
  }
});

// 기능 사용량 API
app.get('/admin/analytics/features', basicAuth, async (req, res) => {
  try {
    const data = await gaServer.analytics.getFeatureUsage();
    res.json(data || { error: 'Feature usage data not available' });
  } catch (err) {
    await logger.log.error('기능 사용량 API 오류', err);
    res.status(500).json({ error: 'Failed to retrieve feature usage data' });
  }
});

// 사용자 유지율 API
app.get('/admin/analytics/retention', basicAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await gaServer.analytics.getRetentionRate(days);
    res.json(data || { error: 'Retention data not available' });
  } catch (err) {
    await logger.log.error('사용자 유지율 API 오류', err);
    res.status(500).json({ error: 'Failed to retrieve retention data' });
  }
});

// 구독자 통계 API
app.get('/admin/analytics/subscribers', basicAuth, async (req, res) => {
  try {
    // GA 데이터 가져오기
    const gaData = await gaServer.analytics.getSubscriberStats();
    
    // 현재 메모리에 있는 실시간 구독자 수
    const currentSubscribers = subscriptions.length;
    
    res.json({
      current: currentSubscribers,
      subscribed: gaData?.subscribed || 0,
      unsubscribed: gaData?.unsubscribed || 0
    });
  } catch (err) {
    await logger.log.error('구독자 통계 API 오류', err);
    res.status(500).json({ error: 'Failed to retrieve subscriber data' });
  }
});

// 관리자 대시보드 HTML 페이지
app.get('/admin/dashboard', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/dashboard.html'));
});

/* ───────────── 13. 서버 시작 ───────────── */
app.listen(PORT, async () => {
  await logger.log.info(`서버 시작됨 → http://localhost:${PORT}`);
  await logger.log.info(`현재 ${subscriptions.length}개의 구독과 ${Object.keys(scheduledLoaders).length}개의 타이머가 메모리에 로드됨`);
  
  // 서버 시작 이벤트를 GA에 전송
  gaServer.trackEvent('server_started', { 
    subscriptions: subscriptions.length,
    timers: Object.keys(scheduledLoaders).length,
    hostname: os.hostname()
  });
});