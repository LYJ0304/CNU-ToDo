/**
 * ga-server.js - 구글 애널리틱스 서버 측 연동 모듈
 * AutoDCS 프로젝트의 서버 측 GA 연동 기능을 제공합니다.
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');
const { fetch } = require('undici'); // Node.js 18 미만 버전용
const logger = require('./logger'); // 기존 로거 활용

// GA4 API 클라이언트 초기화 (설정 방식)
let analyticsDataClient = null;
const GA_CONFIG = {
  propertyId: process.env.GA_PROPERTY_ID || '',
  apiSecret: process.env.GA_API_SECRET || '',
  keyFilePath: process.env.GA_KEY_FILE_PATH || ''
};

// 초기화 함수
function initGA() {
  // 환경 변수 확인
  if (!GA_CONFIG.propertyId) {
    logger.log.warn('구글 애널리틱스 Property ID가 설정되지 않았습니다. GA 기능이 비활성화됩니다.');
    return false;
  }

  // API 클라이언트 초기화
  try {
    if (GA_CONFIG.keyFilePath) {
      analyticsDataClient = new BetaAnalyticsDataClient({
        keyFilename: GA_CONFIG.keyFilePath,
      });
      logger.log.info('구글 애널리틱스 API 클라이언트 초기화 완료');
      return true;
    } else {
      logger.log.warn('구글 애널리틱스 서비스 계정 키 파일 경로가 설정되지 않았습니다.');
      return false;
    }
  } catch (err) {
    logger.log.error('구글 애널리틱스 클라이언트 초기화 오류', err);
    return false;
  }
}

// 서버 이벤트를 GA로 전송하는 배치 시스템
class GABatchManager {
  constructor() {
    this.eventQueue = [];
    this.batchSize = 20;
    this.batchInterval = 60000; // 1분마다 전송
    this.timer = null;
    this.enabled = !!GA_CONFIG.propertyId && !!GA_CONFIG.apiSecret;
    
    if (!this.enabled) {
      logger.log.warn('GA_PROPERTY_ID 또는 GA_API_SECRET이 설정되지 않아 이벤트 추적이 비활성화됩니다.');
    }
  }

  // 초기화
  init() {
    if (!this.enabled) return;
    
    this.timer = setInterval(() => this.flushEvents(), this.batchInterval);
    process.on('exit', () => this.flushEvents());
    logger.log.info('GA 배치 매니저 초기화 완료');
  }

  // 이벤트 추가
  addEvent(eventName, params = {}, clientId = 'server') {
    if (!this.enabled) return false;
    
    this.eventQueue.push({
      eventName,
      params: { 
        ...params,
        transport_type: 'beacon',
        engagement_time_msec: 1
      },
      clientId,
      timestamp: Date.now()
    });

    if (this.eventQueue.length >= this.batchSize) {
      this.flushEvents();
    }
    
    return true;
  }

  // 모든 이벤트 전송
  async flushEvents() {
    if (!this.enabled || this.eventQueue.length === 0) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    try {
      // Measurement Protocol API로 이벤트 전송
      const response = await fetch(
        `https://www.google-analytics.com/mp/collect?measurement_id=${GA_CONFIG.propertyId}&api_secret=${GA_CONFIG.apiSecret}`,
        {
          method: 'POST',
          body: JSON.stringify({
            client_id: 'autodcs_server',
            timestamp_micros: Date.now() * 1000,
            non_personalized_ads: true,
            events
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.log.error(`GA 데이터 전송 실패: ${errorText}`);
      } else {
        logger.log.info(`GA 이벤트 ${events.length}개 전송 성공`);
      }
    } catch (err) {
      logger.log.error('GA 이벤트 전송 오류', err);
      // 실패한 이벤트 다시 큐에 추가
      this.eventQueue.push(...events);
    }
  }
}

// 분석 보고서 가져오기 함수
async function getAnalyticsReport(startDate, endDate, metrics = [], dimensions = []) {
  if (!analyticsDataClient) {
    logger.log.warn('GA 클라이언트가 초기화되지 않았습니다.');
    return null;
  }

  try {
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${GA_CONFIG.propertyId}`,
      dateRanges: [{ startDate, endDate }],
      metrics: metrics.map(name => ({ name })),
      dimensions: dimensions.map(name => ({ name }))
    });

    return formatReportResponse(response);
  } catch (err) {
    logger.log.error('GA 보고서 조회 오류', err);
    return null;
  }
}

// 보고서 응답 형식화
function formatReportResponse(response) {
  const result = {
    dimensions: [],
    metrics: [],
    rows: []
  };

  // 차원 및 지표 이름 추출
  response.dimensionHeaders?.forEach(header => {
    result.dimensions.push(header.name);
  });
  
  response.metricHeaders?.forEach(header => {
    result.metrics.push(header.name);
  });

  // 데이터 행 처리
  response.rows?.forEach(row => {
    const formattedRow = {
      dimensions: {},
      metrics: {}
    };
    
    row.dimensionValues?.forEach((value, idx) => {
      formattedRow.dimensions[result.dimensions[idx]] = value.value;
    });
    
    row.metricValues?.forEach((value, idx) => {
      formattedRow.metrics[result.metrics[idx]] = value.value;
    });
    
    result.rows.push(formattedRow);
  });

  return result;
}

// 주요 분석 보고서 함수들
const analytics = {
  // 일일 사용자 수 (DAU)
  async getDailyActiveUsers(days = 30) {
    const startDate = getDateBefore(days);
    const endDate = 'today';
    
    return getAnalyticsReport(
      startDate, 
      endDate,
      ['activeUsers', 'sessions'], 
      ['date']
    );
  },

  // 총 설치 수
  async getTotalInstallations() {
    return getAnalyticsReport(
      '2020-01-01', 
      'today',
      ['eventCount'], 
      ['eventName']
    ).then(data => {
      if (!data) return 0;
      
      const installEvents = data.rows.filter(
        row => row.dimensions.eventName === 'app_installed'
      );
      return installEvents.length > 0 ? 
        Number(installEvents[0].metrics.eventCount) : 0;
    });
  },
  
  // 기능별 사용량
  async getFeatureUsage() {
    return getAnalyticsReport(
      '30daysAgo', 
      'today',
      ['eventCount', 'eventCountPerUser'], 
      ['eventName']
    );
  },
  
  // 사용자 유지율
  async getRetentionRate(days = 7) {
    return getAnalyticsReport(
      `${days}daysAgo`, 
      'today',
      ['newUsers', 'returnedUsers', 'totalUsers'],
      ['date']
    );
  },
  
  // 구독자 통계
  async getSubscriberStats() {
    return getAnalyticsReport(
      '30daysAgo',
      'today',
      ['eventCount'], 
      ['eventName']
    ).then(data => {
      if (!data) return { subscribed: 0, unsubscribed: 0 };
      
      const subscribed = data.rows.filter(
        row => row.dimensions.eventName === 'notification_subscribed'
      );
      
      const unsubscribed = data.rows.filter(
        row => row.dimensions.eventName === 'notification_unsubscribed'
      );
      
      return {
        subscribed: subscribed.length > 0 ? Number(subscribed[0].metrics.eventCount) : 0,
        unsubscribed: unsubscribed.length > 0 ? Number(unsubscribed[0].metrics.eventCount) : 0
      };
    });
  }
};

// 날짜 계산 헬퍼
function getDateBefore(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

// GA 배치 매니저 생성
const gaBatch = new GABatchManager();

// 모듈 내보내기
module.exports = {
  analytics,
  trackEvent: (name, params, clientId) => gaBatch.addEvent(name, params, clientId),
  getAnalyticsReport,
  initGA,
  init: () => {
    const initialized = initGA();
    if (initialized) {
      gaBatch.init();
    }
    return initialized;
  }
}; 