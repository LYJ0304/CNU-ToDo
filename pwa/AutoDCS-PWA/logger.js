/**
 * logger.js - AutoDCS 로깅 시스템
 * 
 * 이 모듈은 시스템 로그 및 사용자 액션 로그를 관리하는 기능을 제공합니다.
 */

const path = require('path');
const fs = require('fs').promises;

/* ───────────── 로깅 관련 상수 ───────────── */
const USER_LOGS_DIR = path.join(__dirname, 'logs', 'user_actions');
const SYSTEM_LOGS_DIR = path.join(__dirname, 'logs', 'system');
const LOG_ROTATION_DAYS = 30; // 30일 후 로그 삭제

// 시스템 로그 함수
async function logToFile(message, type = 'info') {
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    const logFilePath = path.join(SYSTEM_LOGS_DIR, `system_${dateStr}.log`);
    
    // 로그 형식: [시간] [타입] 메시지
    const logLine = `[${timeStr}] [${type.toUpperCase()}] ${message}\n`;
    
    // 콘솔 출력
    if (type === 'error') {
      console.error(`[${timeStr}] ${message}`);
    } else {
      console.log(`[${timeStr}] ${message}`);
    }
    
    // 파일에 추가
    await fs.appendFile(logFilePath, logLine, 'utf8');
    return true;
  } catch (err) {
    console.error(`로그 저장 실패: ${err.message}`);
    return false;
  }
}

// 간편 로그 함수들
const log = {
  info: (msg) => logToFile(msg, 'info'),
  error: (msg, err) => {
    const errorMsg = err ? `${msg}: ${err.message || err}` : msg;
    return logToFile(errorMsg, 'error');
  },
  warn: (msg) => logToFile(msg, 'warn'),
  debug: (msg) => {
    if (process.env.DEBUG) {
      return logToFile(msg, 'debug');
    }
    return Promise.resolve();
  }
};

// 로그 디렉토리가 없으면 생성
async function ensureLogDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'logs'), { recursive: true });
    await fs.mkdir(USER_LOGS_DIR, { recursive: true });
    await fs.mkdir(SYSTEM_LOGS_DIR, { recursive: true });
    await log.info('로그 디렉토리 준비 완료');
  } catch (err) {
    console.error('로그 디렉토리 생성 오류:', err);
  }
}

// 로그 저장 함수
async function saveUserActionLog(logData) {
  try {
    // 일별 로그 파일 사용
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const logFilePath = path.join(USER_LOGS_DIR, `user_actions_${dateStr}.jsonl`);
    
    // 로그에 서버 타임스탬프 추가
    logData.server_timestamp = now.toISOString();
    logData.server_hostname = require('os').hostname();
    
    // JSONL 형식으로 저장 (각 줄이 유효한 JSON 객체, 줄바꿈으로 구분)
    const logLine = JSON.stringify(logData) + '\n';
    
    // 파일에 추가
    await fs.appendFile(logFilePath, logLine, 'utf8');
    return true;
  } catch (err) {
    await log.error('사용자 액션 로그 저장 오류', err);
    return false;
  }
}

// 오래된 로그 정리 함수
async function cleanupOldLogs() {
  try {
    // 사용자 액션 로그 정리
    const userFiles = await fs.readdir(USER_LOGS_DIR);
    const now = Date.now();
    const cutoffTime = now - (LOG_ROTATION_DAYS * 24 * 60 * 60 * 1000);
    
    for (const file of userFiles) {
      if (!file.startsWith('user_actions_') || !file.endsWith('.jsonl')) continue;
      
      // 파일명에서 날짜 추출 (user_actions_YYYY-MM-DD.jsonl)
      const dateStr = file.replace('user_actions_', '').replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();
      
      // 오래된 로그 삭제
      if (fileDate < cutoffTime) {
        const filePath = path.join(USER_LOGS_DIR, file);
        await fs.unlink(filePath);
        await log.info(`오래된 로그 파일 삭제: ${file}`);
      }
    }
    
    // 시스템 로그 정리
    const systemFiles = await fs.readdir(SYSTEM_LOGS_DIR);
    for (const file of systemFiles) {
      if (!file.startsWith('system_') || !file.endsWith('.log')) continue;
      
      // 파일명에서 날짜 추출 (system_YYYY-MM-DD.log)
      const dateStr = file.replace('system_', '').replace('.log', '');
      const fileDate = new Date(dateStr).getTime();
      
      // 오래된 로그 삭제
      if (fileDate < cutoffTime) {
        const filePath = path.join(SYSTEM_LOGS_DIR, file);
        await fs.unlink(filePath);
        await log.info(`오래된 시스템 로그 파일 삭제: ${file}`);
      }
    }
  } catch (err) {
    await log.error('로그 정리 중 오류', err);
  }
}

// 로그 통계 생성 함수
async function generateLogStats() {
  try {
    const files = await fs.readdir(USER_LOGS_DIR);
    const stats = {
      totalActions: 0,
      actionsPerDay: {},
      popularActions: {},
      viewStats: {
        main: 0,
        calendar: 0,
        settings: 0
      },
      deviceStats: {
        desktop: 0,
        mobile: 0,
        tablet: 0
      },
      installStats: {
        installed: 0,
        browser: 0
      },
      themeStats: {
        light: 0,
        dark: 0,
        system: 0
      }
    };
    
    // 최근 7일간의 로그만 처리
    const now = new Date();
    const recentFiles = files
      .filter(f => f.startsWith('user_actions_') && f.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, 7);
    
    for (const file of recentFiles) {
      const filePath = path.join(USER_LOGS_DIR, file);
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      
      const dateStr = file.replace('user_actions_', '').replace('.jsonl', '');
      stats.actionsPerDay[dateStr] = 0;
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const log = JSON.parse(line);
          stats.totalActions++;
          stats.actionsPerDay[dateStr]++;
          
          // 액션 유형 카운트
          stats.popularActions[log.action] = (stats.popularActions[log.action] || 0) + 1;
          
          // 뷰 통계
          if (log.appState && log.appState.currentView) {
            const view = log.appState.currentView.replace('#', '');
            if (stats.viewStats[view] !== undefined) {
              stats.viewStats[view]++;
            }
          }
          
          // 디바이스 타입 추정
          if (log.deviceInfo && log.deviceInfo.userAgent) {
            const ua = log.deviceInfo.userAgent.toLowerCase();
            if (ua.includes('mobile')) {
              stats.deviceStats.mobile++;
            } else if (ua.includes('tablet')) {
              stats.deviceStats.tablet++;
            } else {
              stats.deviceStats.desktop++;
            }
          }
          
          // 설치 통계
          if (log.deviceInfo && log.deviceInfo.standalone !== undefined) {
            if (log.deviceInfo.standalone) {
              stats.installStats.installed++;
            } else {
              stats.installStats.browser++;
            }
          }
          
          // 테마 통계
          if (log.action === 'theme_changed' && log.details && log.details.mode) {
            stats.themeStats[log.details.mode]++;
          }
        } catch (e) {
          await log.error('로그 파싱 오류', e);
        }
      }
    }
    
    // 가장 인기 있는 액션 정렬
    stats.popularActions = Object.entries(stats.popularActions)
      .sort((a, b) => b[1] - a[1])
      .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
    
    return stats;
  } catch (err) {
    await log.error('로그 통계 생성 오류', err);
    return null;
  }
}

// 일일 로그 정리 스케줄링 함수
function scheduleLogCleanup() {
  const scheduleNextCleanup = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const delay = tomorrow.getTime() - now.getTime();
    setTimeout(async () => {
      await cleanupOldLogs();
      scheduleNextCleanup(); // 다음 날로 재스케줄
    }, delay);
  };
  
  scheduleNextCleanup();
}

// 초기화 함수
async function initializeLogger() {
  // 로그 디렉토리 준비
  await ensureLogDirectories();
  
  // 초기 로그 정리
  await cleanupOldLogs();
  
  // 일일 로그 정리 스케줄링
  scheduleLogCleanup();
  
  await log.info('로깅 시스템 초기화 완료');
}

// 모듈 내보내기
module.exports = {
  log,
  initializeLogger,
  saveUserActionLog,
  cleanupOldLogs,
  generateLogStats,
  USER_LOGS_DIR,
  SYSTEM_LOGS_DIR
}; 