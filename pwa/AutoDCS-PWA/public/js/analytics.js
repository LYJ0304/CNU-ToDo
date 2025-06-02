/**
 * analytics.js - 사용자 액션 로깅 시스템
 * 클라이언트 측 로깅 기능을 담당하는 파일입니다.
 */

// 사용자 액션을 로깅하는 함수
function logUserAction(action, details = {}) {
  try {
    // 디바이스 정보 수집
    const deviceInfo = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      standalone: window.navigator.standalone || false,
      isApp: window.matchMedia('(display-mode: standalone)').matches,
      isTouch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0
    };

    // 앱 상태 정보 수집
    const appState = {
      currentView: window.location.hash || '#main',
      currentTheme: localStorage.getItem('theme') || 'system'
    };

    // 세션 ID 가져오기 (없으면 생성)
    let sessionId = localStorage.getItem('session_id');
    if (!sessionId) {
      sessionId = 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem('session_id', sessionId);
    }

    // 로그 데이터 구성
    const logData = {
      action,
      details,
      sessionId,
      timestamp: new Date().toISOString(),
      deviceInfo,
      appState
    };

    // 서버에 로그 전송
    fetch('/log/user_action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(logData),
      // 로깅 실패해도 사용자 경험에 영향을 주지 않기 위해 keep-alive 설정
      keepalive: true
    }).catch(err => {
      // 로깅 실패는 조용히 무시 (사용자 경험에 영향 주지 않음)
      console.warn('로그 전송 실패:', err);
    });

    return true;
  } catch (err) {
    console.error('로깅 오류:', err);
    return false;
  }
}

// 에러 로깅 함수
function logError(errorMsg, errorObj = null) {
  const details = {
    error: errorMsg,
    stack: errorObj?.stack || null,
    url: window.location.href
  };
  
  return logUserAction('error', details);
}

// 페이지 뷰 로깅
function logPageView(viewName) {
  return logUserAction('page_view', { view: viewName });
}

// 설정 변경 로깅
function logSettingsChange(settingName, oldValue, newValue) {
  return logUserAction('settings_changed', {
    setting: settingName,
    from: oldValue,
    to: newValue
  });
}

// 테마 변경 로깅
function logThemeChange(mode) {
  return logUserAction('theme_changed', { mode });
}

// 알림 관련 로깅
function logNotificationAction(action, details = {}) {
  return logUserAction(`notification_${action}`, details);
}

// 전역 에러 핸들러 등록
window.addEventListener('error', (event) => {
  logError(event.message, {
    stack: event.error?.stack || 'No stack trace available',
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  });
});

// Promise 에러 핸들러 등록
window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason;
  logError('Unhandled Promise Rejection', {
    message: error?.message || 'Unknown promise error',
    stack: error?.stack || 'No stack trace available'
  });
});

// 모바일 이벤트 포착
let lastTouchEnd = 0;
document.addEventListener('touchend', (event) => {
  const now = new Date().getTime();
  if (now - lastTouchEnd <= 300) {
    // 더블 탭 감지
    logUserAction('double_tap', {
      target: event.target.tagName,
      x: event.changedTouches[0].screenX,
      y: event.changedTouches[0].screenY
    });
  }
  lastTouchEnd = now;
}, false);

// 모바일 앱으로 설치 감지
window.addEventListener('appinstalled', (event) => {
  logUserAction('app_installed');
});

// 앱 시작 시 로깅
document.addEventListener('DOMContentLoaded', () => {
  logUserAction('app_started', {
    referrer: document.referrer,
    standalone: navigator.standalone || window.matchMedia('(display-mode: standalone)').matches
  });
});

// 날짜 선택 로깅
function logDateSelection(startDate, endDate) {
  return logUserAction('date_selected', {
    start: startDate,
    end: endDate
  });
}

// 데이터 로딩 로깅
function logDataLoad(dataType, success, details = {}) {
  return logUserAction('data_loaded', {
    type: dataType,
    success,
    ...details
  });
}

// 전역으로 내보내기
window.Analytics = {
  logUserAction,
  logError,
  logPageView,
  logSettingsChange,
  logThemeChange,
  logNotificationAction,
  logDateSelection,
  logDataLoad
}; 