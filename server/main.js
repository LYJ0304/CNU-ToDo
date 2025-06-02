const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.AUTODCS_PORT || 9316
const SECRET_KEY = process.env.AUTODCS_KEY || "your-default-secret-key"

// 로그 디렉토리 설정
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// 사용자 액션 로그 디렉토리 설정
const userActionLogDir = path.join(logDir, 'user_actions');
if (!fs.existsSync(userActionLogDir)) {
  fs.mkdirSync(userActionLogDir);
}

// 로그 파일 경로 생성
const currentDate = new Date();
const timestamp = currentDate.toISOString().replace(/:/g, '-').replace(/\..+/, '');
const logFileName = `autodcs-server-${timestamp}.log`;
const logFilePath = path.join(logDir, logFileName);

// 로그 스트림 생성
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// 로그 함수 정의
function logToFile(message) {
  const now = new Date();
  const koreaTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const time = koreaTime.toISOString().replace('Z', '(KST)');
  const logMessage = `[${time}] ${message}\n`;
  
  // 콘솔과 파일에 모두 로그 기록
  console.log(logMessage.trim());
  logStream.write(logMessage);
}

// 사용자 액션 로그 처리 함수
function logUserAction(actionData) {
  try {
    // 타임스탬프 추가
    const now = new Date();
    const koreaTime = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    actionData.server_timestamp = koreaTime.toISOString();
    
    // 날짜별 로그 파일 사용
    const today = koreaTime.toISOString().split('T')[0]; // YYYY-MM-DD
    const actionLogFileName = `user-actions-${today}.jsonl`;
    const actionLogFilePath = path.join(userActionLogDir, actionLogFileName);
    
    // 로그 데이터 포맷팅 (JSON Lines 형식)
    const logEntry = JSON.stringify(actionData) + '\n';
    
    // 파일에 추가
    fs.appendFileSync(actionLogFilePath, logEntry);
    
    // 서버 로그에도 요약 정보 기록
    let summaryMessage = `사용자 액션: ${actionData.action}`;
    
    if (actionData.studentHash) {
      summaryMessage += ` | 학번 해시: ${actionData.studentHash}`;
    }
    
    if (actionData.details) {
      const detailsStr = Object.entries(actionData.details)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      
      if (detailsStr) {
        summaryMessage += ` | 상세: ${detailsStr}`;
      }
    }
    
    logToFile(summaryMessage);
    return true;
  } catch (err) {
    logToFile(`사용자 액션 로깅 오류: ${err.message}`);
    console.error('사용자 액션 로깅 오류:', err);
    return false;
  }
}

// 오래된 로그 정리 함수 (30일 이상된 로그 삭제)
function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(userActionLogDir);
    const now = Date.now();
    const cutoffTime = now - (30 * 24 * 60 * 60 * 1000); // 30일
    
    for (const file of files) {
      if (!file.startsWith('user-actions-') || !file.endsWith('.jsonl')) continue;
      
      // 파일명에서 날짜 추출 (user-actions-YYYY-MM-DD.jsonl)
      const dateStr = file.replace('user-actions-', '').replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();
      
      // 오래된 로그 삭제
      if (fileDate < cutoffTime) {
        const filePath = path.join(userActionLogDir, file);
        fs.unlinkSync(filePath);
        logToFile(`오래된 로그 파일 삭제: ${file}`);
      }
    }
  } catch (err) {
    logToFile(`로그 정리 중 오류: ${err.message}`);
    console.error('로그 정리 중 오류:', err);
  }
}

// 로깅 관련 초기화
function initLogging() {
  // 매일 자정에 로그 정리 실행
  const scheduleNextCleanup = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const delay = tomorrow.getTime() - now.getTime();
    setTimeout(() => {
      cleanupOldLogs();
      scheduleNextCleanup(); // 다음 날로 재스케줄
    }, delay);
    
    logToFile(`다음 로그 정리 예약됨: ${new Date(tomorrow).toISOString()}`);
  };
  
  // 초기 로그 정리 및 스케줄링
  cleanupOldLogs();
  scheduleNextCleanup();
}

// 로깅 시스템 초기화
initLogging();

// 로그 남기기
function FetchLog(kako_id, type) {
  // 이미 기본 로그 함수가 있으므로 logToFile 함수만 호출합니다
  // 중복 로그 문제를 해결하기 위해 console.log는 제거합니다
  logToFile(`${kako_id} ${type}`);
}

// CORS 설정
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// JSON 바디 파싱 미들웨어
app.use(express.json());

// 데이터를 저장할 디렉토리 (todo_list 데이터 파일들이 저장됨)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// user id와 학번의 매핑 정보를 저장할 파일 경로 (새 구조: { userId: [hashedStudentNo, order_type] })
const mappingFilePath = path.join(__dirname, 'mapping.json');
// 매핑 파일이 없으면 초기화
if (!fs.existsSync(mappingFilePath)) {
  fs.writeFileSync(mappingFilePath, JSON.stringify({}));
}

// 비밀키 검증 미들웨어
function checkSecretKey(req, res, next) {
  const key = req.headers['x-secret-key'];
  if (!key || key !== SECRET_KEY) {
    return res.status(403).json({ error: "Unauthorized: invalid secret key." });
  }
  next();
}

// 헬퍼 함수: 매핑 파일 읽기
function loadMapping() {
  try {
    const data = fs.readFileSync(mappingFilePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    const errorMsg = "Mapping file 읽기 오류: " + err.message;
    logToFile(errorMsg);
    console.error(errorMsg);
    return {};
  }
}

// 헬퍼 함수: 매핑 파일 저장
function saveMapping(mapping) {
  fs.writeFileSync(mappingFilePath, JSON.stringify(mapping, null, 2));
}

// due_date ("YYYYMMDDHHMMSS")를 "MM-DD HH:MM" 형식으로 변환하는 기존 함수 (유지)
function formatDueDate(due) {
  if (due && due.length >= 12) {
    return due.substring(4,6) + "-" + due.substring(6,8) + " " + due.substring(8,10) + ":" + due.substring(10,12);
  }
  return due;
}

// 새 함수: due_date를 "MM-DD (요일) HH:MM" 형식으로 변환
function formatDueDateWithDay(due) {
  if (due && due.length >= 12) {
    const year = parseInt(due.substring(0, 4));
    const month = due.substring(4, 6);
    const day = due.substring(6, 8);
    const hour = due.substring(8, 10);
    const minute = due.substring(10, 12);
    const dateObj = new Date(year, parseInt(month)-1, parseInt(day), parseInt(hour), parseInt(minute));
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    const dayLetter = days[dateObj.getDay()];
    return `${month}-${day} (${dayLetter}) ${hour}:${minute}`;
  }
  return due;
}

// update_time (ISO 형식)을 "MM/DD HH:mm 기준" 형식으로 변환하는 함수
function formatUpdateTime(updateTimeStr) {
  const updateTime = new Date(updateTimeStr);
  const month = ("0" + (updateTime.getMonth() + 1)).slice(-2);
  const day = ("0" + updateTime.getDate()).slice(-2);
  const hours = ("0" + updateTime.getHours()).slice(-2);
  const minutes = ("0" + updateTime.getMinutes()).slice(-2);
  return `${month}/${day} ${hours}:${minutes} 기준`;
}

// module_type 변환 매핑
const moduleTypeMapping = {
  LV: "콘텐츠",
  LD: "토론",
  LS: "자료실",
  LR: "과제",
  LT: "팀프로젝트",
  LQ: "퀴즈",
  LE: "시험"
};

/**
 * [등록/수정 엔드포인트] POST /mapping
 * payload.userRequest.user.id와 payload.userRequest.utterance(학번 평문)를 받아,
 * 학번을 SHA‑256 해시 처리한 값을 매핑의 첫 번째 요소로 저장하고, 신규 등록 시 order_type은 "과목"으로 초기화합니다.
 */
app.post('/mapping', checkSecretKey,(req, res) => {
  const payload = req.body;
  const userId = payload.userRequest && payload.userRequest.user && payload.userRequest.user.id;
  if (!userId) {
    logToFile("매핑 실패: User id가 payload에 존재하지 않음");
    return res.status(400).json({ error: 'User id가 payload에 존재하지 않습니다.' });
  }
  const studentNo = payload.userRequest && payload.userRequest.utterance;
  if (!studentNo) {
    return res.status(400).json({ error: 'Utterance(학번)이 payload에 존재하지 않습니다.' });
  }
  const hashedStudentNo = crypto.createHash('sha256').update(studentNo).digest('hex');
  const mapping = loadMapping();
  
  // 로그 먼저 기록
  FetchLog(userId, "학번 등록/업데이트");
  
  if (mapping[userId]) {
    if (mapping[userId][0] === hashedStudentNo) {
      return res.json({ message: '학번이 동일합니다. 업데이트가 필요하지 않습니다.', userId, studentNo, hashed: hashedStudentNo, order_type: mapping[userId][1] });
    } else {
      mapping[userId][0] = hashedStudentNo;
      if (!mapping[userId][1]) {
        mapping[userId][1] = "과목";
      }
      saveMapping(mapping);
      return res.json({ message: '학번 업데이트 성공', userId, studentNo, hashed: hashedStudentNo, order_type: mapping[userId][1] });
    }
  } else {
    mapping[userId] = [hashedStudentNo, "과목"];
    saveMapping(mapping);
    return res.json({ message: '학번 등록 성공', userId, studentNo, hashed: hashedStudentNo, order_type: "과목" });
  }
});

/**
 * [주문 유형 업데이트 엔드포인트] POST /skill/order
 * payload.userRequest.user.id와 payload.userRequest.utterance(주문 유형 텍스트)를 받아,
 * 매핑 파일의 해당 사용자의 두 번째 요소(order_type)를 업데이트합니다.
 */
app.post('/skill/order', checkSecretKey,(req, res) => {
  const payload = req.body;
  const userId = payload.userRequest && payload.userRequest.user && payload.userRequest.user.id;
  if (!userId) {
    return res.status(400).json({ error: 'User id가 payload에 존재하지 않습니다.' });
  }
  const orderType = payload.userRequest && payload.userRequest.utterance;
  if (!orderType) {
    return res.status(400).json({ error: 'Utterance(주문 유형)이 payload에 존재하지 않습니다.' });
  }
  const mapping = loadMapping();
  if (!mapping[userId]) {
    return res.status(400).json({ error: '등록된 학번 정보가 없습니다. 먼저 /mapping 엔드포인트를 통해 학번을 등록해 주세요.' });
  }
  mapping[userId][1] = orderType;
  saveMapping(mapping);
  
  // 로그 먼저 기록 후 응답
  FetchLog(userId, "주문 유형 업데이트");
  res.json({ message: '주문 유형 업데이트 성공', userId, order_type: orderType });
});

/**
 * [정보 저장 엔드포인트] POST /store
 * 해시 처리된 user_no와 todo_list, update_time 등을 포함한 JSON 데이터를 받아,
 * data/<user_no>.json 파일로 저장합니다.
 */
app.post('/store', (req, res) => {
  // 응답이 이미 전송되었는지 확인하는 플래그
  let responseHandled = false;
  
  // 응답 헬퍼 함수
  const sendResponse = (status, data) => {
    if (!responseHandled) {
      responseHandled = true;
      res.status(status).json(data);
    } else {
      logToFile(`경고: 중복된 응답 시도가 감지되었습니다. status=${status}`);
    }
  };

  const data = req.body;
  if (!data.user_no) {
    logToFile("저장 실패: user_no 값이 없음");
    return sendResponse(400, { error: 'user_no 값이 필요합니다.' });
  }
  
  const fileName = data.user_no + '.json';
  const filePath = path.join(dataDir, fileName);
  
  // todo_list가 있으면 전체 덮어쓰기 - 더 간단한 경로 먼저 처리
  if (data.todo_list) {
  fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
    if (err) {
        const errorMsg = "파일 저장 오류: " + err.message;
        logToFile(errorMsg);
        console.error(errorMsg);
        return sendResponse(500, { error: '파일 저장 오류' });
      }
      
      FetchLog(data.user_no, "ToDoList 저장");
      return sendResponse(200, { message: '전체 데이터 저장 성공', user_no: data.user_no });
    });
    return; // 명시적으로 함수 종료
  }
  
  // todo_list가 없으면 update_time만 갱신 - 더 복잡한 경로
  fs.readFile(filePath, 'utf8', (readErr, fileData) => {
    if (readErr) {
      const errorMsg = "기존 파일 읽기 오류: " + readErr.message;
      logToFile(errorMsg);
      console.error(errorMsg);
      return sendResponse(500, { error: '기존 데이터 읽기 오류' });
    }
    
    try {
      const existing = JSON.parse(fileData);
      existing.update_time = data.update_time;

      fs.writeFile(filePath, JSON.stringify(existing, null, 2), writeErr => {
        if (writeErr) {
          const errorMsg = "update_time 저장 오류: " + writeErr.message;
          logToFile(errorMsg);
          console.error(errorMsg);
          return sendResponse(500, { error: 'update_time 저장 오류' });
        }
        
        FetchLog(data.user_no, "UpdateTime만 저장");
        return sendResponse(200, { message: 'update_time만 갱신 성공', user_no: data.user_no });
      });
    } catch (parseErr) {
      const errorMsg = "기존 JSON 파싱 오류: " + parseErr.message;
      logToFile(errorMsg);
      console.error(errorMsg);
      return sendResponse(500, { error: '기존 데이터 파싱 오류' });
    }
  });
});

/**
 * [데이터 조회 엔드포인트] GET /fetch
 * "hashedstudentno" 헤더에 해시된 학번을 담아 요청하면, 해당 파일의 JSON 데이터를 반환합니다.
 */
app.get('/fetch', (req, res) => {
  const hashedStudentNo = req.headers['hashedstudentno'];
  if (!hashedStudentNo) {
    logToFile("조회 실패: 해시된 학번이 제공되지 않음");
    return res.status(400).json({ 
      error: '해시된 학번이 제공되지 않았습니다.',
      message: '요청에 학번 정보가 포함되어 있지 않습니다. 학번을 입력한 후 다시 시도해주세요.' 
    });
  }
  
  const fileName = hashedStudentNo + '.json';
  const filePath = path.join(dataDir, fileName);
  
  fs.readFile(filePath, 'utf8', (err, fileData) => {
    if (err) {
      const errorMsg = `파일 읽기 오류: 해시된 학번 ${hashedStudentNo} - ${err.message}`;
      logToFile(errorMsg);
      console.error(errorMsg);
      return res.status(404).json({ 
        error: `해당 학번으로 저장된 데이터가 없습니다.`,
        message: `입력한 학번에 해당하는 데이터를 찾을 수 없습니다. 학번을 확인하거나 먼저 데이터를 저장해주세요.` 
      });
    }
    try {
      const jsonData = JSON.parse(fileData);
      logToFile(`해시된 학번 ${hashedStudentNo} 조회 성공`);
      res.json(jsonData);
    } catch (error) {
      const errorMsg = `JSON 파싱 오류: 해시된 학번 ${hashedStudentNo} - ${error.message}`;
      logToFile(errorMsg);
      console.error(errorMsg);
      res.status(500).json({ 
        error: '저장된 데이터를 불러올 수 없습니다.',
        message: '데이터 형식에 문제가 있습니다. 관리자에게 문의하세요.' 
      });
    }
  });
});

/**
 * [Kakao 챗봇 스킬 엔드포인트] POST /skill
 * payload.userRequest.user.id를 사용해 매핑된 학번(해시 처리된 값)과 주문 유형(order_type)을 조회한 후,
 * order_type에 따라 todo_list 데이터를 다른 방식으로 포맷하여 응답합니다.
 */
app.post('/skill', checkSecretKey, (req, res) => {
  // 응답이 이미 전송되었는지 확인하는 플래그
  let responseHandled = false;
  
  // 응답 헬퍼 함수
  const sendResponse = (data) => {
    if (!responseHandled) {
      responseHandled = true;
  res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(data));
    } else {
      logToFile(`경고: /skill 중복된 응답 시도가 감지되었습니다. data=${JSON.stringify(data)}`);
    }
  };

  const payload = req.body;
  const userId = payload.userRequest && payload.userRequest.user && payload.userRequest.user.id;
  if (!userId) {
    logToFile("스킬 호출 실패: userId가 없음");
    return sendResponse({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "User id가 제공되지 않았습니다." } }] }
    });
  }

  const mapping = loadMapping();
  const studentNo = mapping[userId] ? mapping[userId][0] : null;
  const orderType = mapping[userId] ? mapping[userId][1] : "과목"; // 기본값 "과목"
  
  if (!studentNo) {
    logToFile(`스킬 호출 실패: userId=${userId}에 해당하는 학번 정보 없음`);
    return sendResponse({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "등록된 학번 정보가 없습니다. 학번을 등록해 주세요." } }] }
    });
  }
  
  const fileName = studentNo + '.json';
  const filePath = path.join(dataDir, fileName);
  
  fs.readFile(filePath, 'utf8', (err, fileData) => {
    let responseText = "";
    if (err) {
      const errorMsg = `파일 읽기 오류: userId=${userId}, studentNo=${studentNo} - ${err.message}`;
      logToFile(errorMsg);
      console.error(errorMsg);
      responseText = "저장된 데이터가 없습니다.";
      return sendResponse({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: responseText } }] }
      });
    }
    
    try {
      const jsonData = JSON.parse(fileData);
      
      if (jsonData.todo_list && Array.isArray(jsonData.todo_list) && jsonData.todo_list.length > 0) {
        if (orderType === "과목") {
          // "과목" 포맷: course별 그룹화, 각 course 내에서 type별 그룹화 및 due_date 그룹화
          const groupedCourses = {};
          jsonData.todo_list.forEach(item => {
            const course = item.course_nm;
            if (!groupedCourses[course]) {
              groupedCourses[course] = [];
            }
            groupedCourses[course].push(item);
          });
          for (const course in groupedCourses) {
            responseText += "📚" + course + "\n";
            const typeGroups = {};
            groupedCourses[course].forEach(item => {
              const key = `${item.type}||${item.due_date}`;
              if (!typeGroups[key]) {
                typeGroups[key] = [];
              }
              typeGroups[key].push(item.item_title_temp);
            });
            for (const key in typeGroups) {
              const [type, due] = key.split('||');
              // 날짜 포맷: (~MM-DD (요일) HH:MM)
              const formattedDue = formatDueDateWithDay(due);
              const titles = typeGroups[key].join("\n• ");
              responseText += `[${type}]\n`;
              responseText += `• ${titles}\n`;
              responseText += `(~${formattedDue})\n\n`;
            }
          }
        } else if (orderType === "날짜") {
          // "날짜" 포맷: todo_list를 due_date 기준 오름차순 정렬 후, due_date별로 그룹화
          let sortedList = jsonData.todo_list.slice().sort((a, b) => a.due_date.localeCompare(b.due_date));
          const groupsByDue = {};
          sortedList.forEach(item => {
            const due = item.due_date;
            if (!groupsByDue[due]) {
              groupsByDue[due] = [];
            }
            groupsByDue[due].push(item);
          });
          for (const due of Object.keys(groupsByDue).sort((a, b) => a.localeCompare(b))) {
            // 헤더: ⏰(MM-DD (요일) HH:MM)
            const formattedDue = formatDueDateWithDay(due);
            responseText += `⏰[${formattedDue}]\n`;
            // 그룹 내 항목들을 course_nm별로 그룹화
            const courses = {};
            groupsByDue[due].forEach(item => {
              const course = item.course_nm;
              if (!courses[course]) {
                courses[course] = [];
              }
              courses[course].push(item);
            });
            for (const course in courses) {
              responseText += `[${course}]\n`;
              // 그룹화: type별
              const types = {};
              courses[course].forEach(item => {
                const type = item.type;
                if (!types[type]) {
                  types[type] = [];
                }
                types[type].push(item.item_title_temp);
              });
              for (const type in types) {
                responseText += `${type}:\n`;
                types[type].forEach(title => {
                  responseText += `• ${title}\n`;
                });
              }
              responseText += "\n";
            }
            responseText += "\n";
          }
        } else if (orderType === "유형") {
          // "유형" 포맷: type별 그룹화, 각 그룹 내 항목은 course_nm - item_title_temp (기한: formattedDue) 형태로 출력
          const groupedByType = {};
          jsonData.todo_list.forEach(item => {
            const type = item.type;
            if (!groupedByType[type]) {
              groupedByType[type] = [];
            }
            groupedByType[type].push(item);
          });
          for (const type in groupedByType) {
            responseText += `[${type}]\n`;
            groupedByType[type].forEach(item => {
              responseText += `• ${item.course_nm} - ${item.item_title_temp} (기한: ${formatDueDate(item.due_date)})\n`;
            });
            responseText += "\n";
          }
        } else {
          // 기본 "과목" 포맷 사용
          const groupedCourses = {};
          jsonData.todo_list.forEach(item => {
            const course = item.course_nm;
            if (!groupedCourses[course]) {
              groupedCourses[course] = [];
            }
            groupedCourses[course].push(item);
          });
          for (const course in groupedCourses) {
            responseText += "📚" + course + "\n";
            const typeGroups = {};
            groupedCourses[course].forEach(item => {
              const key = `${item.type}||${item.due_date}`;
              if (!typeGroups[key]) {
                typeGroups[key] = [];
              }
              typeGroups[key].push(item.item_title_temp);
            });
            for (const key in typeGroups) {
              const [type, due] = key.split('||');
              const formattedDue = formatDueDateWithDay(due);
              const titles = typeGroups[key].join(", ");
              responseText += `[${type}]\n`;
              responseText += `• ${titles}\n`;
              responseText += `(~${formattedDue})\n\n`;
            }
          }
        }
      } else {
        responseText = "저장된 데이터가 없습니다.";
      }
      // 마지막 줄에 update_time 추가 (MM/DD HH:mm 기준)
      if (jsonData.update_time) {
        responseText += `[${formatUpdateTime(jsonData.update_time)}]`;
      }
      
      FetchLog(studentNo, "카톡 투두 조회");
      return sendResponse({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: responseText } }] }
      });
    } catch (error) {
      const errorMsg = `JSON 파싱 오류: userId=${userId}, studentNo=${studentNo} - ${error.message}`;
      logToFile(errorMsg);
      console.error(errorMsg);
      return sendResponse({
        version: "2.0",
        template: { outputs: [{ simpleText: { text: "저장된 데이터 파싱 오류" } }] }
      });
    }
  });
});

// 액세스 로그 미들웨어
app.use((req, res, next) => {
  const start = Date.now();
  
  // 응답이 완료된 후 로깅
  res.on('finish', () => {
    const duration = Date.now() - start;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const sanitizedIp = ip ? ip.toString().replace(/\d+$/, 'xxx') : 'unknown'; // 마지막 옥텟 마스킹
    
    logToFile(`${sanitizedIp} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  
  next();
});

// 요청 본문 크기 제한 증가
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/**
 * [사용자 액션 로그 API] POST /log/action
 * 클라이언트에서 보낸 사용자 액션 로그를 저장합니다.
 */
app.post('/log/action', (req, res) => {
  try {
    const logData = req.body;
    
    // 필수 필드 검증
    if (!logData || !logData.action) {
      return res.status(400).json({ error: 'Invalid log data. Action field is required.' });
    }
    
    // IP 주소 마스킹 및 추가
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const sanitizedIp = ip ? ip.toString().replace(/\d+$/, 'xxx') : 'unknown';
    logData.ip = sanitizedIp;
    
    // 로그 저장
    const success = logUserAction(logData);
    
    if (success) {
      res.status(200).json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save log' });
    }
  } catch (err) {
    logToFile(`액션 로그 API 오류: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * [로그 통계 API] GET /admin/stats
 * 관리자용 로그 통계를 반환합니다.
 */
app.get('/admin/stats', checkSecretKey, (req, res) => {
  try {
    // 통계 계산
    const stats = generateLogStats();
    res.json(stats);
  } catch (err) {
    logToFile(`통계 API 오류: ${err.message}`);
    res.status(500).json({ error: 'Failed to generate statistics' });
  }
});

// 로그 통계 생성 함수
function generateLogStats() {
  try {
    const files = fs.readdirSync(userActionLogDir);
    
    // 통계 객체 초기화
    const stats = {
      totalActions: 0,
      actionsByDay: {},
      actionTypes: {},
      topActions: {},
      errors: 0,
      uniqueUsers: new Set(),
      recentActivity: []
    };
    
    // 최근 7일 파일만 필터링
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
    
    const recentFiles = files
      .filter(file => file.startsWith('user-actions-') && file.endsWith('.jsonl'))
      .filter(file => {
        const dateStr = file.replace('user-actions-', '').replace('.jsonl', '');
        return new Date(dateStr) >= sevenDaysAgo;
      })
      .sort();
    
    // 각 파일 처리
    for (const file of recentFiles) {
      const dateStr = file.replace('user-actions-', '').replace('.jsonl', '');
      stats.actionsByDay[dateStr] = 0;
      
      const filePath = path.join(userActionLogDir, file);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const lines = fileContent.trim().split('\n');
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const entry = JSON.parse(line);
          stats.totalActions++;
          stats.actionsByDay[dateStr]++;
          
          // 액션 타입 카운트
          stats.actionTypes[entry.action] = (stats.actionTypes[entry.action] || 0) + 1;
          
          // 세션ID 기준 고유 사용자 수집
          if (entry.sessionId) {
            stats.uniqueUsers.add(entry.sessionId);
          }
          
          // 최근 활동 추적 (최대 100개)
          if (stats.recentActivity.length < 100) {
            stats.recentActivity.push({
              timestamp: entry.server_timestamp || entry.timestamp,
              action: entry.action,
              details: entry.details
            });
          }
          
          // 오류 카운트
          if (entry.action === 'error' || (entry.details && entry.details.error)) {
            stats.errors++;
          }
        } catch (e) {
          logToFile(`로그 항목 파싱 오류: ${e.message}`);
        }
      }
    }
    
    // 인기 액션 계산 (상위 10개)
    stats.topActions = Object.entries(stats.actionTypes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
    
    // Set을 숫자로 변환
    stats.uniqueUsers = stats.uniqueUsers.size;
    
    // 최근 활동 정렬
    stats.recentActivity.sort((a, b) => {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
    
    return stats;
  } catch (err) {
    logToFile(`로그 통계 생성 오류: ${err.message}`);
    throw new Error('Failed to generate log statistics');
  }
}

// 서버 시작 시 등록된 라우트 확인 (중복 감지)
app.listen(port, () => {
  const startMessage = `서버가 내부 포트 ${port}에서 실행 중입니다.`;
  logToFile(`서버 시작: ${startMessage}`);
  console.log(startMessage);
  logToFile(`로그 파일 경로: ${logFilePath}`);
  logToFile(`사용자 액션 로그 디렉토리: ${userActionLogDir}`);
});

// 프로세스 종료 시 로그 스트림 닫기
process.on('SIGINT', () => {
  logToFile('서버가 종료됩니다.');
  logStream.end();
  process.exit();
});

process.on('SIGTERM', () => {
  logToFile('서버가 종료됩니다.');
  logStream.end();
  process.exit();
});