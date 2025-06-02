// version 1.0.003
// background.js
// user_no를 SHA-256 해시하는 함수 (Web Crypto API 사용)
function hashUserNo(userNo) {
  const encoder = new TextEncoder();
  const data = encoder.encode(userNo);
  return crypto.subtle.digest('SHA-256', data).then(hashBuffer => {
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  });
}

// due_date ("YYYYMMDDHHMMSS")를 "MM-DD HH:MM" 형식으로 변환
function formatDueDate(due) {
  if (due && due.length >= 12) {
    return (
      due.substring(4, 6) +
      "-" +
      due.substring(6, 8) +
      " " +
      due.substring(8, 10) +
      ":" +
      due.substring(10, 12)
    );
  }
  return due;
}

// module_type 매핑
const moduleTypeMapping = {
  LV: "콘텐츠",
  LD: "토론",
  LS: "자료실",
  LR: "과제",
  LT: "팀프로젝트",
  LQ: "퀴즈",
  LE: "시험"
};

const targetPage = "https://dcs-learning.cnu.ac.kr/home";

chrome.webNavigation.onCompleted.addListener(
  details => {
    console.log("홈 페이지 접속 감지:", details.url);
    const tabId = details.tabId;

    /* ---------------- ① Todo 목록 요청 ---------------- */
    const fetchTodo = fetch(
      "https://dcs-learning.cnu.ac.kr/api/v1/week/getStdTodoList",
      {
        headers: {
          accept: "*/*",
          "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          Referer: "https://dcs-learning.cnu.ac.kr/std/todo",
          "Referrer-Policy": "strict-origin-when-cross-origin"
        },
        body:
          "e=KFvMQEoHCB52Y6z06Y6FePBasnitf8TakHBW53IKlbyZ0toDJoY0eF71MrhIDKApN9vopx9gTqDrX7r1dn4Zag%3D%3D",
        method: "POST"
      }
    )
      .then(response => {
        if (!response.ok) {
          throw new Error(
            "getStdTodoList 네트워크 응답 오류: " + response.statusText
          );
        }
        return response.json();
      })
      .then(data => {
        const transformed = { todo_list: [] };
        if (data.body && data.body.todo_list) {
          transformed.todo_list = data.body.todo_list.map(item => ({
            course_nm: item.course_nm,
            due_date: item.edate_temp,
            info: item.info.replace(/[-:\s]/g, ""), // YYYYMMDDHHMMSS
            item_title_temp: item.item_title_temp,
            type: moduleTypeMapping[item.module_type] || item.module_type
          }));
        }
        return transformed;
      });

    /* ---------------- ② 사용자 정보 요청 ---------------- */
    const fetchUser = fetch(
      "https://dcs-learning.cnu.ac.kr/api/v1/user/getUserInfo",
      {
        headers: {
          accept: "*/*",
          "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest"
        },
        referrer: "https://dcs-learning.cnu.ac.kr/home",
        referrerPolicy: "strict-origin-when-cross-origin",
        method: "POST",
        mode: "cors",
        credentials: "include"
      }
    )
      .then(response => {
        if (!response.ok) {
          throw new Error(
            "getUserInfo 네트워크 응답 오류: " + response.statusText
          );
        }
        return response.json();
      })
      .then(data => (data.body && data.body.user_no ? data.body.user_no : "user_no 없음"));

    /* ---------------- ③ 두 요청 결과 합치기 ---------------- */
    Promise.all([fetchTodo, fetchUser])
      .then(([todoData, userNo]) =>
        hashUserNo(userNo).then(hashedUserNo => ({ todoData, hashedUserNo }))
      )
      .then(({ todoData, hashedUserNo }) => {
        const combinedResult = {
          todo_list: todoData.todo_list,
          user_no: hashedUserNo,
          update_time: new Date().toISOString()
        };

        // 이전 데이터와 최근 최소 업데이트 시간 가져오기
        chrome.storage.local.get(['combinedResult', 'lastMinimalUpdate'], result => {
          const stored = result.combinedResult;
          const lastMinimal = result.lastMinimalUpdate;
          const isSame =
            stored &&
            JSON.stringify(stored.todo_list) ===
              JSON.stringify(combinedResult.todo_list);

          if (isSame) {
            const now = Date.now();
            // 최근 5분 내 최소 업데이트 전송이 있었다면 건너뛰기
            if (lastMinimal && now - lastMinimal < 5 * 60 * 1000) {
              chrome.scripting.executeScript({
                target: { tabId },
                function: () => console.log("최근 5분 내 update_time-only 전송 생략"),
              });
              return;
            }

            // 최소 페이로드 (update_time만)
            const minimalPayload = {
              user_no: combinedResult.user_no,
              update_time: combinedResult.update_time
            };

            fetch("http://autodcs.kro.kr:9943/store", {
              method: "POST",
              mode: "cors",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(minimalPayload)
            })
              .then(r => {
                if (!r.ok) throw new Error("서버 응답 오류: " + r.statusText);
                return r.json();
              })
              .then(serverRes => {
                // 로컬 저장소에 update_time과 마지막 최소 업데이트 시간 갱신
                const newStored = { ...stored, update_time: combinedResult.update_time };
                chrome.storage.local.set(
                  {
                    combinedResult: newStored,
                    lastMinimalUpdate: now
                  },
                  () =>
                    chrome.scripting.executeScript({
                      target: { tabId },
                      function: res => console.log("update_time만 전송, 서버 응답:", res),
                      args: [serverRes]
                    })
                );
              })
              .catch(err =>
                chrome.scripting.executeScript({
                  target: { tabId },
                  function: e => console.error("서버 전송 오류:", e),
                  args: [err.toString()]
                })
              );

          } else {
            // 전체 변경 발생 시 전체 데이터 전송
            fetch("http://autodcs.kro.kr:9943/store", {
              method: "POST",
              mode: "cors",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(combinedResult)
            })
              .then(r => {
                if (!r.ok) throw new Error("서버 응답 오류: " + r.statusText);
                return r.json();
              })
              .then(serverRes =>
                chrome.storage.local.set(
                  { combinedResult },
                  () =>
                    chrome.scripting.executeScript({
                      target: { tabId },
                      function: res => console.log("서버 저장 응답:", res),
                      args: [serverRes]
                    })
                )
              )
              .catch(err =>
                chrome.scripting.executeScript({
                  target: { tabId },
                  function: e => console.error("서버 전송 오류:", e),
                  args: [err.toString()]
                })
              );
          }
        });
      })
      .catch(err =>
        chrome.scripting.executeScript({
          target: { tabId },
          function: e => console.error("통합 fetch 오류:", e),
          args: [err.toString()]
        })
      );
  },
  { url: [{ urlMatches: "^https://dcs-learning\\.cnu\\.ac\\.kr/" }] }
);
