/* ==================== 智能问答引擎系统扩展 (QA Engine) ==================== */
const qaEngine = {
    // 缓存最近3轮提及的科目
    subjectCache: [], 
    // 保留上一轮检测到的激活学期
    currentSemester: "2026-春季学期",

    // 省略式及话题清理断言
    omitKeywords: ["那", "它", "这", "然后", "还有", "具体", "哪个"],
    switchKeywords: ["换话题", "换一个", "不聊这个", "聊点别的", "换个问题", "别的", "换个", "不问这个"],

    // 清空缓存上下文
    clearContext() {
        this.subjectCache = [];
        this.updateStatusUI();
    },

    getContextSummary() {
        if (this.subjectCache.length === 0) return "无上下文";
        return `当前话题: ${this.subjectCache[this.subjectCache.length - 1]} (${this.currentSemester})`;
    },

    updateStatusUI() {
        const textEl = document.getElementById('context-summary-text');
        const indicator = document.getElementById('context-indicator');
        const inputEl = document.getElementById('user-input');
        
        if (!textEl) return;
        
        const summary = this.getContextSummary();
        textEl.innerText = summary === "无上下文" ? "当前上下文：无" : summary;
        
        if (summary === "无上下文") {
            indicator.className = "w-2 h-2 rounded-full bg-slate-300";
            if (inputEl) inputEl.placeholder = "试试输入：'今天下午有什么课？'...";
        } else {
            indicator.className = "w-2 h-2 rounded-full bg-blue-500 animate-pulse";
            const curSub = this.subjectCache[this.subjectCache.length - 1];
            if (inputEl) inputEl.placeholder = `继续询问关于 ${curSub} 的问题...`;
        }
    },

    // 核心流处理入口
    processQuestion(rawQuery) {
        let query = rawQuery.trim();
        
        // 1. 话题切换主动清理检测
        if (this.switchKeywords.some(kw => query.includes(kw))) {
            this.clearContext();
            insertSystemMessage("🔄 检测到话题切换，已自动清空上下文");
            return { handled: true, text: "好的，我们换个话题。您请说，接下来想了解哪方面的内容？" };
        }

        // 2. 省略式追问判别与上下文深度补全
        const isOmit = this.omitKeywords.some(kw => query.startsWith(kw));
        let sourceTag = null;
        if (isOmit && this.subjectCache.length > 0) {
            const lastSubject = this.subjectCache[this.subjectCache.length - 1];
            query = lastSubject + " " + query; // 补全到当前指令
            sourceTag = `继承上下文话题: ${lastSubject}`;
        }

        // 3. 提取关联的物理科目实体（歧义判定依据）
        const courses = JSON.parse(localStorage.getItem('cm_courses') || '[]');
        const matchedSubjects = [...new Set(courses.map(c => c.name).filter(name => query.includes(name) || name.includes(query)))];

        // 判定上下文补充
        if (matchedSubjects.length === 0 && this.subjectCache.length > 0) {
            // 如果没提到任何新科目但存在老缓存，自动补入
            matchedSubjects.push(this.subjectCache[this.subjectCache.length - 1]);
        }

        // 4. 多重主体冲突——触发歧义容错中断机制
        if (matchedSubjects.length > 1 && !isOmit) {
            return { needsClarification: true, candidates: matchedSubjects };
        }

        // 5. 维护最近 3 轮科目滑动窗口缓存
        if (matchedSubjects.length === 1) {
            if (!this.subjectCache.includes(matchedSubjects[0])) {
                this.subjectCache.push(matchedSubjects[0]);
                if (this.subjectCache.length > 3) this.subjectCache.shift();
            }
        }
        this.updateStatusUI();

        // 6. 核心规则树匹配分发
        const replyHtml = matchNlpLogic(query);
        return { handled: true, text: replyHtml, source: sourceTag };
    }
};

/* ==================== UI 层重构与事件绑定映射 ==================== */

// 系统消息渲染气泡
function insertSystemMessage(text) {
    const chatBox = document.getElementById('chat-box');
    if (!chatBox) return;
    const sysDiv = document.createElement('div');
    sysDiv.className = "flex justify-center my-2 animate-fade-in";
    sysDiv.innerHTML = `<span class="bg-slate-200/80 text-slate-600 text-[11px] font-medium px-2.5 py-1 rounded-xl shadow-sm border border-slate-300/30">${text}</span>`;
    chatBox.appendChild(sysDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// 覆写原 handleSend 执行逻辑（注入上下文标签和歧义检测）
function handleSend(e) {
    if(e) e.preventDefault();
    const inputEl = document.getElementById('user-input');
    const question = inputEl.value.trim();
    if(!question) return;

    appendChatMessage('user', question);
    inputEl.value = '';
    
    appendLoadingIndicator();

    setTimeout(() => {
        removeLoadingIndicator();
        
        // 调度全新问答引擎
        const res = qaEngine.processQuestion(question);
        
        if (res.needsClarification) {
            openClarifyModal(res.candidates, question);
        } else if (res.handled) {
            // 改造：如果存在来源标签，在原有逻辑之上携带显示
            let finalContent = res.text;
            if (res.source) {
                finalContent = `<div class="text-[10px] text-blue-500 font-bold mb-1 flex items-center"><i class="fas fa-link mr-1"></i>${res.source}</div>` + finalContent;
            }
            appendChatMessage('ai', finalContent, true);
            
            // 同步历史记录存储结构
            const history = JSON.parse(localStorage.getItem('cm_history') || '[]');
            history.unshift({ id: Date.now(), question: question, answer: res.text, timestamp: new Date().toLocaleString() });
            localStorage.setItem('cm_history', JSON.stringify(history));
            refreshChatSideSummary();
        }
    }, 450);
}

// 歧义弹窗交互控制
let activeAmbiguousQuery = "";
function openClarifyModal(candidates, originalQuery) {
    activeAmbiguousQuery = originalQuery;
    const modal = document.getElementById('clarify-modal');
    const container = document.getElementById('clarify-candidates');
    
    container.innerHTML = candidates.map(c => `
        <button onclick="resolveClarify('${c}')" class="w-full py-2 bg-blue-50 text-blue-600 text-xs font-semibold rounded-xl hover:bg-blue-100 transition text-left px-4 flex justify-between items-center">
            <span>${c}</span><i class="fas fa-chevron-right text-blue-300"></i>
        </button>
    `).join('');
    
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function closeClarifyModal() {
    const modal = document.getElementById('clarify-modal');
    modal.classList.add('opacity-0');
    setTimeout(() => modal.classList.add('hidden'), 200);
}

function resolveClarify(selectedSubject) {
    closeClarifyModal();
    // 补全科目名称后重新查询
    document.getElementById('user-input').value = `${selectedSubject} ${activeAmbiguousQuery}`;
    handleSend();
}

// 键盘 ESC 兜底容错关闭弹窗
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeClarifyModal();
        closeExamModal();
    }
});

// 重置对话交互（含二次弹窗确认控制）
function triggerResetContext() {
    openConfirmModal(
        "确认清空所有上下文？",
        "这将清空当前的会话，并开始全新的对话!",
        () => {
            qaEngine.clearContext();
            const chatBox = document.getElementById('chat-box');
            if (chatBox) chatBox.innerHTML = ""; // 清空聊天主区域
            insertSystemMessage("🔄 已重置对话，上下文已清空");
            document.getElementById('user-input').value = "";
            qaEngine.updateStatusUI();
        }
    );
}

/* ==================== 考试倒计时功能实现架构 ==================== */
function openExamModal() { document.getElementById('exam-modal').classList.remove('hidden'); }
function closeExamModal() { document.getElementById('exam-modal').classList.add('hidden'); }

function saveExam(e) {
    e.preventDefault();
    const name = document.getElementById('exam-name').value.trim();
    const date = document.getElementById('exam-date').value;
    const location = document.getElementById('exam-location').value.trim();
    const semester = document.getElementById('exam-semester').value;

    const exams = JSON.parse(localStorage.getItem('cm_exams') || '[]');
    exams.push({ id: Date.now(), name, date, location, semester });
    localStorage.setItem('cm_exams', JSON.stringify(exams));
    
    showToast("考试日程安排已录入！");
    closeExamModal();
    document.getElementById('exam-form').reset();
    renderExamCountdownModule();
}

function deleteExam(id) {
    openConfirmModal("确认删除该考试计划？", "此移除操作不可撤销，请知悉。", () => {
        const exams = JSON.parse(localStorage.getItem('cm_exams') || '[]');
        localStorage.setItem('cm_exams', JSON.stringify(exams.filter(e => e.id !== id)));
        showToast("考试日程已移除", "info");
        renderExamCountdownModule();
    });
}

function renderExamCountdownModule() {
    const exams = JSON.parse(localStorage.getItem('cm_exams') || '[]');
    const gridEl = document.getElementById('exam-countdown-grid');
    const overviewEl = document.getElementById('exam-overview-text');
    if(!gridEl) return;

    if (exams.length === 0) {
        gridEl.innerHTML = `<div class="col-span-full bg-white p-6 border border-dashed rounded-2xl text-center text-slate-400 text-xs">暂无期末统一考试时间录入</div>`;
        if(overviewEl) overviewEl.innerText = "当前考试总数：0 门";
        return;
    }

    // 排序逻辑：将最近的考试排在前面，已过期的放最后面
    const sortedExams = [...exams].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let activeUpcoming = null;
    let upcomingMinDays = Infinity;
    const todayStr = new Date().toISOString().split('T')[0];
    const todayTime = new Date(todayStr).getTime();

    const htmlCards = sortedExams.map(exam => {
        const examTime = new Date(exam.date).getTime();
        const diffTime = examTime - todayTime;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        let cardStyle = "bg-white border-slate-200 text-slate-800";
        let countdownText = `距考试还有 <b class="text-base font-mono">${diffDays}</b> 天`;

        if (diffDays < 0) {
            cardStyle = "bg-rose-50 border-rose-200 text-rose-900 opacity-75";
            countdownText = `<span class="text-rose-600 font-bold"><i class="fas fa-exclamation-triangle mr-1"></i>⚠️ 已过期</span>`;
        } else if (diffDays <= 3) {
            cardStyle = "bg-rose-50 border-rose-200 text-rose-900";
            countdownText = `🔥 极度紧迫：还有 <b class="text-lg text-rose-600 font-mono">${diffDays}</b> 天`;
        } else if (diffDays <= 7) {
            cardStyle = "bg-amber-50 border-amber-200 text-amber-900";
            countdownText = `⏳ 临近预警：还有 <b class="text-base text-amber-600 font-mono">${diffDays}</b> 天`;
        }

        if (diffDays >= 0 && diffDays < upcomingMinDays) {
            upcomingMinDays = diffDays;
            activeUpcoming = exam.name;
        }

        return `
            <div class="p-4 border rounded-2xl shadow-sm flex flex-col justify-between transition ${cardStyle}">
                <div class="space-y-1">
                    <div class="flex justify-between items-start">
                        <h4 class="font-bold text-sm truncate max-w-[75%]">${exam.name}</h4>
                        <span class="text-[10px] bg-slate-200/60 font-medium px-2 py-0.5 rounded text-slate-600 whitespace-nowrap">${exam.semester}</span>
                    </div>
                    <p class="text-xs opacity-75"><i class="fas fa-map-marker-alt mr-1"></i>${exam.location}</p>
                    <p class="text-[11px] font-mono opacity-60"><i class="fas fa-calendar-day mr-1"></i>日期: ${exam.date}</p>
                </div>
                <div class="mt-4 pt-2.5 border-t border-slate-200/50 flex justify-between items-center text-xs">
                    <div>${countdownText}</div>
                    <button onclick="deleteExam(${exam.id})" class="text-slate-400 hover:text-rose-600 transition p-1"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>
        `;
    }).join('');

    gridEl.innerHTML = htmlCards;
    
    // 更新统计概览
    if (overviewEl) {
        overviewEl.innerHTML = activeUpcoming 
            ? `最近考试：<b class="text-slate-700">${activeUpcoming}</b> (<span class="text-orange-500 font-bold">${upcomingMinDays}天后</span>) ｜ 考试总数：${exams.length} 门`
            : `当前暂无未考项目 ｜ 考试总数：${exams.length} 门`;
    }
}

// 挂载至初始化勾子中
const originalRenderScheduleModule = renderScheduleModule;
renderScheduleModule = function() {
    originalRenderScheduleModule();
    renderExamCountdownModule();
};

// 页面初次加载时执行一次状态刷新
document.addEventListener('DOMContentLoaded', () => {
    qaEngine.updateStatusUI();
    setInterval(renderExamCountdownModule, 60000); // 后台每分钟增量刷新倒计时计算
});



/* ==================== 1. 初始化 Mock 核心数据集 ==================== */
const DEFAULT_COURSES = [
    { id: 1, name: '高等数学(下)', teacher: '张教授', classroom: '理科楼302', weekday: 1, startTime: '08:00', endTime: '09:45' },
    { id: 2, name: '大学英语(Ⅳ)', teacher: 'Smith', classroom: '外语楼101', weekday: 1, startTime: '10:00', endTime: '11:45' },
    { id: 3, name: '计算机网络原理', teacher: '李副教授', classroom: '信工楼504', weekday: 2, startTime: '14:00', endTime: '15:45' },
    { id: 4, name: '数据结构基础', teacher: '王教授', classroom: '实验楼202', weekday: 3, startTime: '08:00', endTime: '09:45' },
    { id: 5, name: '思想道德与法治', teacher: '赵老师', classroom: '一教大礼堂', weekday: 4, startTime: '10:00', endTime: '11:45' },
    { id: 6, name: '人工智能导论', teacher: '刘博士', classroom: '信工楼102', weekday: 5, startTime: '16:00', endTime: '17:45' }
];

const DEFAULT_HOMEWORKS = [
    { id: 1, subject: '数据结构基础', content: '完成二叉树遍历核心算法代码实现并提交至平台。', deadline: getRelativeDate(1), status: 'pending' },
    { id: 2, subject: '计算机网络原理', content: '课后习题第三章（抓包分析明细计算题）。', deadline: getRelativeDate(3), status: 'pending' },
    { id: 3, subject: '大学英语(Ⅳ)', content: '准备单元课文短评演讲稿草稿。', deadline: getRelativeDate(5), status: 'done' }
];

const DEFAULT_PLANS = [
    { id: 1, subject: '自主复习', content: '刷高数往年期末真题两套，订正错题集。', date: getRelativeDate(0), duration: 120, completed: false },
    { id: 2, subject: '毕业规划', content: '完善个人简历和前端工程项目集。', date: getRelativeDate(2), duration: 90, completed: true }
];

const DEFAULT_GRADES = [
    { id: 1, subject: '高等数学(下)', score: 92, semester: '2025-秋季学期', examDate: '2025-01-10' },
    { id: 2, subject: '大学英语(Ⅳ)', score: 88, semester: '2025-秋季学期', examDate: '2025-01-12' },
    { id: 3, subject: '计算机网络原理', score: 85, semester: '2025-秋季学期', examDate: '2025-01-15' },
    { id: 4, subject: '离散数学', score: 78, semester: '2025-秋季学期', examDate: '2025-01-08' },
    { id: 5, subject: '数据结构基础', score: 95, semester: '2026-春季学期', examDate: '2026-06-20' },
    { id: 6, subject: '人工智能导论', score: 90, semester: '2026-春季学期', examDate: '2026-06-25' }
];

function getRelativeDate(daysOffset) {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    return d.toISOString().split('T')[0];
}

// 初始化本地存储
function initLocalStorage() {
    if (!localStorage.getItem('cm_courses')) localStorage.setItem('cm_courses', JSON.stringify(DEFAULT_COURSES));
    if (!localStorage.getItem('cm_homeworks')) localStorage.setItem('cm_homeworks', JSON.stringify(DEFAULT_HOMEWORKS));
    if (!localStorage.getItem('cm_plans')) localStorage.setItem('cm_plans', JSON.stringify(DEFAULT_PLANS));
    if (!localStorage.getItem('cm_grades')) localStorage.setItem('cm_grades', JSON.stringify(DEFAULT_GRADES));
    if (!localStorage.getItem('cm_history')) localStorage.setItem('cm_history', JSON.stringify([]));
}
initLocalStorage();

/* ==================== 2. 全局基础交互与工具函数 ==================== */
// Toast 反馈提示
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = document.getElementById('toast-icon');
    const msg = document.getElementById('toast-msg');
    
    msg.innerText = message;
    if(type === 'success') {
        icon.className = "fas fa-check-circle text-emerald-400";
    } else if (type === 'error') {
        icon.className = "fas fa-times-circle text-rose-400";
    } else {
        icon.className = "fas fa-info-circle text-blue-400";
    }
    
    toast.style.transform = "translateY(0)";
    setTimeout(() => {
        toast.style.transform = "translateY(-150%)";
    }, 2500);
}

// 自定义模态框上下文变量
let modalConfirmCallback = null;
function openConfirmModal(title, desc, onConfirm) {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-desc').innerText = desc;
    modal.classList.remove('hidden');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
    modal.querySelector('div').classList.remove('scale-95');
    modalConfirmCallback = onConfirm;
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    modal.classList.add('opacity-0');
    modal.querySelector('div').classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 200);
}

document.getElementById('modal-cancel').addEventListener('click', closeConfirmModal);
document.getElementById('modal-confirm').addEventListener('click', () => {
    if(modalConfirmCallback) modalConfirmCallback();
    closeConfirmModal();
});

// 核心 Tab 切换（一致性导航结构控制）
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`).classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.className = "nav-btn px-4 py-2 rounded-lg text-slate-600 hover:text-slate-900 transition";
    });
    const activeBtn = document.getElementById(`nav-${tabId}`);
    if(activeBtn) {
        activeBtn.className = "nav-btn px-4 py-2 rounded-lg text-blue-600 bg-white shadow-sm transition";
    }
    
    // 切换时触发特定模块的刷新重新渲染
    if(tabId === 'schedule') renderScheduleModule();
    if(tabId === 'tasks') renderTasksModule();
    if(tabId === 'grades') renderGradesDashboard();
    if(tabId === 'history') renderHistoryList();
}

/* ==================== 3. AI问答自然语言交互核心模块 ==================== */
function appendChatMessage(sender, content, isHtml = false) {
    const chatBox = document.getElementById('chat-box');
    const welcomeCard = document.getElementById('welcome-card');
    if(welcomeCard) welcomeCard.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'} mb-4 animate-fade-in`;

    const innerHtml = sender === 'user' ? `
        <div class="max-w-[75%] bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-none text-sm shadow-sm">
            ${content}
        </div>
    ` : `
        <div class="flex items-start space-x-2.5 max-w-[85%]">
            <div class="w-8 h-8 bg-gradient-to-tr from-blue-600 to-indigo-500 text-white rounded-xl flex items-center justify-center text-xs shadow shrink-0">
                <i class="fas fa-robot"></i>
            </div>
            <div class="bg-slate-100 text-slate-800 px-4 py-2.5 rounded-2xl rounded-tl-none text-sm border border-slate-200/60 shadow-sm space-y-2">
                ${isHtml ? content : `<div>${content}</div>`}
            </div>
        </div>
    `;
    msgDiv.innerHTML = innerHtml;
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function appendLoadingIndicator() {
    const chatBox = document.getElementById('chat-box');
    const loadDiv = document.createElement('div');
    loadDiv.id = "ai-loading";
    loadDiv.className = "flex justify-start mb-4";
    loadDiv.innerHTML = `
        <div class="flex items-start space-x-2.5">
            <div class="w-8 h-8 bg-slate-200 text-slate-400 rounded-xl flex items-center justify-center text-xs shrink-0">
                <i class="fas fa-robot"></i>
            </div>
            <div class="bg-slate-100 px-6 py-4 rounded-2xl rounded-tl-none flex items-center justify-center">
                <div class="dot-flashing"></div>
            </div>
        </div>
    `;
    chatBox.appendChild(loadDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function removeLoadingIndicator() {
    const loadDiv = document.getElementById('ai-loading');
    if(loadDiv) loadDiv.remove();
}

function handleSend(e) {
    if(e) e.preventDefault();
    const inputEl = document.getElementById('user-input');
    const question = inputEl.value.trim();
    if(!question) return;

    appendChatMessage('user', question);
    inputEl.value = '';
    
    appendLoadingIndicator();

    // 仿真延迟响应机制 (非功能需求优化: 避免用户焦虑的合理延迟感)
    setTimeout(() => {
        removeLoadingIndicator();
        const matchedAnswer = matchNlpLogic(question);
        appendChatMessage('ai', matchedAnswer, true);
        
        // 本地存储历史问答数据
        const history = JSON.parse(localStorage.getItem('cm_history'));
        history.unshift({
            id: Date.now(),
            question: question,
            answer: matchedAnswer,
            timestamp: new Date().toLocaleString()
        });
        localStorage.setItem('cm_history', JSON.stringify(history));
        refreshChatSideSummary();
    }, 600);
}

function quickQuestion(text) {
    document.getElementById('user-input').value = text;
    handleSend();
}

// 自然语言关键词匹配解析核心逻辑 (容错性机制：提供兜底引导方案)
function matchNlpLogic(query) {
    const q = query.toLowerCase();
    const homeworks = JSON.parse(localStorage.getItem('cm_homeworks'));
    const courses = JSON.parse(localStorage.getItem('cm_courses'));

    if(q.includes('课') || q.includes('教室') || q.includes('上什么')) {
        const todayWeekDay = new Date().getDay() || 7; // 1-7
        const todayCourses = courses.filter(c => c.weekday === todayWeekDay);
        if(todayCourses.length === 0) {
            return `🎉 检查到你<b>今天没有固定的教学安排课程</b>哦！你可以利用富余时间在“计划与作业”模块中安排自习。`;
        }
        let html = `✨ 帮你在后台查到了<b>今天（周${'十一二三四五六日'[todayWeekDay]}）</b>的课程信息：<br><ul class="list-disc pl-4 space-y-1 mt-1">`;
        todayCourses.forEach(c => {
            html += `<li><b>${c.startTime}-${c.endTime}</b> | ${c.name} (${c.classroom} · ${c.teacher})</li>`;
        });
        html += `</ul><span class="text-xs text-blue-500 block mt-2">💡 提示：如需查看完整全周课表，请点击上方“课程表”选项卡。</span>`;
        return html;
    }

    if(q.includes('作业') || q.includes('截止') || q.includes('要交')) {
        const pendingList = homeworks.filter(h => h.status === 'pending');
        if(pendingList.length === 0) {
            return `🟢 恭喜你！当前<b>所有录入的作业均已全部搞定</b>，暂无待完成项，继续保持！`;
        }
        let html = `🚨 盘点完毕，你目前还有 <b>${pendingList.length}</b> 项作业尚未完成，请注意截止时间：<br><ul class="list-disc pl-4 space-y-1 mt-1">`;
        pendingList.forEach(h => {
            html += `<li><span class="text-amber-600 font-medium">[${h.subject}]</span> ${h.content} <span class="text-slate-400 font-mono text-xs">(${h.deadline})</span></li>`;
        });
        html += `</ul>`;
        return html;
    }

    if(q.includes('考试') || q.includes('高数')) {
        return `✍️ <b>期末统一考试日程提醒：</b><br>📚 <b>高等数学(下)</b><br>⏱️ 时间：2026年07月10日 09:00 - 11:00<br>📍 地点：第十五教学楼 301 阶梯教室<br>⚠️ 备注：请携带学生证和2B铅笔。`;
    }

    if(q.includes('成绩') || q.includes('绩点')) {
        return `📊 <b>当前选定学期学业成绩速报：</b><br>你当前已出分科目平均成绩为 <b>92.5</b>，换算绩点约为 <b>4.25 / 5.0</b>。在“数据可视化”大屏中有完整的雷达对比图。`;
    }

    // 兜底引导话术（容错性原则体现）
    return `🤔 抱歉同学，我未能完全理解：“<i>${query}</i>” 的查询意图。<br>💡 <b>你可以尝试以下指令关键词提问：</b><br>• “今天上什么课？” / “查课表”<br>• “有什么作业没写？”<br>• “高数考试在哪个教室？”<br>• “分析一下我的成绩情况”`;
}

// 侧边栏小部件汇总渲染
function refreshChatSideSummary() {
    const courses = JSON.parse(localStorage.getItem('cm_courses'));
    const homeworks = JSON.parse(localStorage.getItem('cm_homeworks'));
    const todayWeekDay = new Date().getDay() || 7;

    // 今日课程
    const todayCourses = courses.filter(c => c.weekday === todayWeekDay);
    const courseListEl = document.getElementById('today-summary-list');
    if(todayCourses.length === 0) {
        courseListEl.innerHTML = `<div class="text-slate-400 text-xs p-3 bg-white border rounded-xl text-center">今日无课，一身轻松</div>`;
    } else {
        courseListEl.innerHTML = todayCourses.map(c => `
            <div class="bg-white p-2.5 border border-slate-200 rounded-xl text-xs flex justify-between items-center shadow-sm">
                <div>
                    <div class="font-bold text-slate-800">${c.name}</div>
                    <div class="text-slate-400 mt-0.5"><i class="fas fa-map-marker-alt mr-1"></i>${c.classroom}</div>
                </div>
                <span class="font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">${c.startTime}</span>
            </div>
        `).join('');
    }

    // 紧急作业
    const pendingHws = homeworks.filter(h => h.status === 'pending');
    const urgentListEl = document.getElementById('urgent-summary-list');
    if(pendingHws.length === 0) {
        urgentListEl.innerHTML = `<div class="text-slate-400 text-xs p-3 bg-white border rounded-xl text-center">暂无截止作业</div>`;
    } else {
        urgentListEl.innerHTML = pendingHws.slice(0,2).map(h => `
            <div class="bg-white p-2.5 border border-slate-200 rounded-xl text-xs border-l-4 border-l-amber-500 shadow-sm">
                <div class="font-bold text-slate-800 truncate">${h.content}</div>
                <div class="text-slate-400 mt-1 flex justify-between items-center">
                    <span>${h.subject}</span>
                    <span class="text-rose-500 font-bold font-mono">${h.deadline}</span>
                </div>
            </div>
        `).join('');
    }
}
refreshChatSideSummary();

/* ==================== 4. 课程表查阅模块 ==================== */
let currentScheduleView = 'week';
function toggleScheduleView(view) {
    currentScheduleView = view;
    document.getElementById('sched-view-week').className = view === 'week' ? "px-3 py-1.5 rounded-lg bg-white shadow-sm text-slate-800" : "px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-800";
    document.getElementById('sched-view-today').className = view === 'today' ? "px-3 py-1.5 rounded-lg bg-white shadow-sm text-slate-800" : "px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-800";
    renderScheduleModule();
}

function renderScheduleModule() {
    const courses = JSON.parse(localStorage.getItem('cm_courses'));
    const weekContainer = document.getElementById('schedule-week-container');
    const todayContainer = document.getElementById('schedule-today-container');

    if(currentScheduleView === 'week') {
        weekContainer.classList.remove('hidden');
        todayContainer.classList.add('hidden');
        
        const timeSlots = [
            { name: '第一大节<br>(08:00 - 09:45)', slotId: 1 },
            { name: '第二大节<br>(10:00 - 11:45)', slotId: 2 },
            { name: '第三大节<br>(14:00 - 15:45)', slotId: 3 },
            { name: '第四大节<br>(16:00 - 17:45)', slotId: 4 }
        ];

        let tbodyHtml = '';
        timeSlots.forEach(slot => {
            tbodyHtml += `<tr class="divide-x divide-slate-100">`;
            tbodyHtml += `<td class="p-3 text-center bg-slate-50 font-medium text-slate-500 border-r">${slot.name}</td>`;
            
            for(let day = 1; day <= 5; day++) {
                // 根据节次时间做模糊映射匹配
                let matched = courses.find(c => c.weekday === day && isCourseInSlot(c, slot.slotId));
                if(matched) {
                    tbodyHtml += `
                        <td class="p-3">
                            <div class="bg-blue-50 border border-blue-100 p-2.5 rounded-xl space-y-1">
                                <div class="font-bold text-blue-700 leading-tight">${matched.name}</div>
                                <div class="text-slate-500 scale-95 origin-left"><i class="fas fa-user text-blue-300 mr-1"></i>${matched.teacher}</div>
                                <div class="text-slate-500 scale-95 origin-left"><i class="fas fa-map-marker-alt text-blue-300 mr-1"></i><b>${matched.classroom}</b></div>
                            </div>
                        </td>
                    `;
                } else {
                    tbodyHtml += `<td class="p-3 text-slate-300 text-center font-light">-</td>`;
                }
            }
            tbodyHtml += `</tr>`;
        });
        document.getElementById('schedule-table-body').innerHTML = tbodyHtml;
    } else {
        weekContainer.classList.add('hidden');
        todayContainer.classList.remove('hidden');
        const todayWeekDay = new Date().getDay() || 7;
        const todayCourses = courses.filter(c => c.weekday === todayWeekDay);
        
        if(todayCourses.length === 0) {
            todayContainer.innerHTML = `<div class="bg-white p-8 border border-dashed text-center rounded-2xl text-slate-400">🎉 今天没有任何安排的课程，好好休息吧！</div>`;
        } else {
            todayContainer.innerHTML = todayCourses.map(c => `
                <div class="bg-white p-4 border border-slate-200 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm">
                    <div class="flex items-center space-x-4">
                        <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-bold"><i class="fas fa-bookmark"></i></div>
                        <div>
                            <h4 class="font-bold text-slate-900">${c.name}</h4>
                            <p class="text-xs text-slate-400 mt-0.5">任课教师：${c.teacher} | 授课地点：<span class="text-slate-700 font-medium">${c.classroom}</span></p>
                        </div>
                    </div>
                    <span class="text-sm font-mono font-bold text-slate-600 bg-slate-100 px-3 py-1 rounded-xl self-start sm:self-auto">${c.startTime} - ${c.endTime}</span>
                </div>
            `).join('');
        }
    }
}

function isCourseInSlot(course, slotId) {
    const startHour = parseInt(course.startTime.split(':')[0]);
    if(slotId === 1 && startHour < 10) return true;
    if(slotId === 2 && startHour >= 10 && startHour < 13) return true;
    if(slotId === 3 && startHour >= 13 && startHour < 16) return true;
    if(slotId === 4 && startHour >= 16) return true;
    return false;
}

/* ==================== 5. 计划与作业管理（含双重红色/橙色高亮警示拦截） ==================== */
function renderTasksModule() {
    const homeworks = JSON.parse(localStorage.getItem('cm_homeworks'));
    const plans = JSON.parse(localStorage.getItem('cm_plans'));

    // 渲染作业列表
    const hwListEl = document.getElementById('homework-list');
    hwListEl.innerHTML = homeworks.map(h => {
        const diffDays = Math.ceil((new Date(h.deadline) - new Date()) / (1000 * 60 * 60 * 24));
        let warnClass = "border-slate-200 bg-white";
        let badgeHtml = "";

        if(h.status === 'pending') {
            if(diffDays <= 0) {
                warnClass = "border-rose-200 bg-rose-50/60";
                badgeHtml = `<span class="bg-rose-500 text-white text-[10px] px-1.5 py-0.5 rounded-md font-bold animate-pulse">今日截止/超期</span>`;
            } else if (diffDays <= 3) {
                warnClass = "border-amber-200 bg-amber-50/40";
                badgeHtml = `<span class="bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded-md font-bold">3天内紧迫</span>`;
            }
        } else {
            warnClass = "border-slate-200 bg-slate-50 opacity-60";
        }

        return `
            <div class="p-4 border rounded-2xl flex items-start justify-between gap-4 transition shadow-sm ${warnClass}">
                <div class="flex items-start space-x-3">
                    <input type="checkbox" ${h.status === 'done'?'checked':''} onclick="toggleHwStatus(${h.id})" class="mt-1 w-4 h-4 text-blue-600 rounded focus:ring-blue-500">
                    <div>
                        <div class="flex items-center space-x-2">
                            <span class="font-bold text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-md">${h.subject}</span>
                            ${badgeHtml}
                        </div>
                        <p class="text-sm text-slate-700 mt-1.5 ${h.status==='done'?'line-through text-slate-400':''}">${h.content}</p>
                        <div class="text-xs text-slate-400 mt-1 font-mono"><i class="fas fa-clock mr-1"></i>截止时限: ${h.deadline}</div>
                    </div>
                </div>
                <button onclick="triggerDeleteTask('homework', ${h.id})" class="text-slate-300 hover:text-rose-500 text-xs transition p-1"><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
    }).join('');

    // 渲染学习计划列表
    const planListEl = document.getElementById('plan-list');
    planListEl.innerHTML = plans.map(p => `
        <div class="p-4 bg-white border border-slate-200 rounded-2xl flex items-start justify-between shadow-sm ${p.completed?'opacity-60 bg-slate-50':''}">
            <div class="flex items-start space-x-3">
                <button onclick="togglePlanStatus(${p.id})" class="mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center text-xs transition ${p.completed?'bg-emerald-500 border-emerald-500 text-white':'border-slate-300 hover:border-blue-500 text-transparent'}">
                    <i class="fas fa-check"></i>
                </button>
                <div>
                    <div class="flex items-center space-x-2">
                        <span class="font-bold text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md">${p.subject}</span>
                        <span class="text-xs font-mono text-slate-400">⏱️ ${p.duration}分钟</span>
                    </div>
                    <p class="text-sm text-slate-700 mt-1.5 ${p.completed?'line-through text-slate-400':''}">${p.content}</p>
                    <div class="text-xs text-slate-400 mt-1 font-mono"><i class="fas fa-calendar mr-1"></i>计划执行日: ${p.date}</div>
                </div>
            </div>
            <button onclick="triggerDeleteTask('plan', ${p.id})" class="text-slate-300 hover:text-rose-500 text-xs transition p-1"><i class="fas fa-trash-alt"></i></button>
        </div>
    `).join('');
}

function toggleHwStatus(id) {
    const hws = JSON.parse(localStorage.getItem('cm_homeworks'));
    const target = hws.find(h => h.id === id);
    if(target) {
        target.status = target.status === 'done' ? 'pending' : 'done';
        localStorage.setItem('cm_homeworks', JSON.stringify(hws));
        showToast(target.status === 'done' ? "作业已标记为完成状态 🎉" : "作业已还原重置");
        renderTasksModule();
        triggerNativeNotification(target);
    }
}

function togglePlanStatus(id) {
    const plans = JSON.parse(localStorage.getItem('cm_plans'));
    const target = plans.find(p => p.id === id);
    if(target) {
        target.completed = !target.completed;
        localStorage.setItem('cm_plans', JSON.stringify(plans));
        showToast(target.completed ? "计划任务已达成！" : "任务已重置");
        renderTasksModule();
    }
}

// 录入弹窗处理
function openAddTaskModal(type) {
    document.getElementById('form-type').value = type;
    document.getElementById('task-form').reset();
    document.getElementById('form-error-tip').classList.add('hidden');
    
    if(type === 'homework') {
        document.getElementById('task-modal-title').innerText = "🚀 新增课程作业提醒";
        document.getElementById('form-date-label').innerText = "截止日期";
        document.getElementById('form-duration-container').classList.add('hidden');
        document.getElementById('form-date').value = getRelativeDate(2);
    } else {
        document.getElementById('task-modal-title').innerText = "💡 制定自主学习计划";
        document.getElementById('form-date-label').innerText = "执行日期";
        document.getElementById('form-duration-container').classList.remove('hidden');
        document.getElementById('form-date').value = getRelativeDate(0);
    }
    document.getElementById('task-modal').classList.remove('hidden');
}

function closeTaskModal() {
    document.getElementById('task-modal').classList.add('hidden');
}

function saveTask(e) {
    e.preventDefault();
    const type = document.getElementById('form-type').value;
    const subject = document.getElementById('form-subject').value.trim();
    const content = document.getElementById('form-content').value.trim();
    const date = document.getElementById('form-date').value;
    const duration = parseInt(document.getElementById('form-duration').value) || 60;

    // 容错拦截校验机制
    if(!subject || !content || !date) {
        document.getElementById('form-error-tip').classList.remove('hidden');
        return;
    }

    if(type === 'homework') {
        const hws = JSON.parse(localStorage.getItem('cm_homeworks'));
        hws.unshift({ id: Date.now(), subject, content, deadline: date, status: 'pending' });
        localStorage.setItem('cm_homeworks', JSON.stringify(hws));
    } else {
        const plans = JSON.parse(localStorage.getItem('cm_plans'));
        plans.unshift({ id: Date.now(), subject, content, date, duration, completed: false });
        localStorage.setItem('cm_plans', JSON.stringify(plans));
    }

    showToast("内容已录入本地缓存成功");
    closeTaskModal();
    renderTasksModule();
}

// 删除二次确认拦截（体现可控性与容错性）
function triggerDeleteTask(type, id) {
    openConfirmModal(
        "确认删除该项记录吗？",
        "数据仅存储于浏览器本地，删除后将永久丢失，不可恢复。",
        () => {
            if(type === 'homework') {
                const hws = JSON.parse(localStorage.getItem('cm_homeworks'));
                localStorage.setItem('cm_homeworks', JSON.stringify(hws.filter(h => h.id !== id)));
            } else {
                const plans = JSON.parse(localStorage.getItem('cm_plans'));
                localStorage.setItem('cm_plans', JSON.stringify(plans.filter(p => p.id !== id)));
            }
            showToast("数据已安全移除", "info");
            renderTasksModule();
        }
    );
}

// 浏览器原生级通知推送机制
function triggerNativeNotification(hwObj) {
    if(!document.getElementById('notify-toggle').checked) return;
    if (Notification.permission === "granted") {
        new Notification(`ClassMate AI 提示`, {
            body: `作业状态更新通知：[${hwObj.subject}] ${hwObj.status === 'done' ? '已标记完成！' : '重置为未完成状态'}`
        });
    } else if (Notification.permission !== "denied") {
        Notification.requestPermission();
    }
}
// 初始拉取授权
if (typeof Notification !== 'undefined' && Notification.permission === "default") {
    Notification.requestPermission();
}

/* ==================== 6. 成绩数据可视化大屏（原生手绘 CSS 直观渲染） ==================== */
function renderGradesDashboard() {
    const grades = JSON.parse(localStorage.getItem('cm_grades'));
    const plans = JSON.parse(localStorage.getItem('cm_plans'));
    const selectSemester = document.getElementById('semester-select').value;

    // 过滤对应学期成绩
    const semGrades = grades.filter(g => g.semester === selectSemester);

    // 1. 统计 KPI 计算
    let avgScore = 0;
    let gpa = 0;
    if(semGrades.length > 0) {
        const totalScore = semGrades.reduce((sum, curr) => sum + curr.score, 0);
        avgScore = (totalScore / semGrades.length).toFixed(1);
        // 转换基础标准绩点算法公式：(分数-50)/10
        const totalGpa = semGrades.reduce((sum, curr) => sum + Math.max(0, (curr.score - 50) / 10), 0);
        gpa = (totalGpa / semGrades.length).toFixed(2);
    }
    document.getElementById('kpi-avg-score').innerText = semGrades.length > 0 ? `${avgScore} 分` : '--';
    document.getElementById('kpi-gpa').innerText = semGrades.length > 0 ? `${gpa} / 5.0` : '--';

    const planCompletionRate = plans.length > 0 ? Math.round((plans.filter(p => p.completed).length / plans.length) * 100) : 0;
    document.getElementById('kpi-completion').innerText = `${planCompletionRate}%`;

    // 2. 渲染手绘柱状对比图表
    const barContainer = document.getElementById('bar-chart-container');
    if(semGrades.length === 0) {
        barContainer.innerHTML = `<div class="text-slate-400 text-xs w-full text-center pb-12">该学期无考试分录数据</div>`;
    } else {
        barContainer.innerHTML = semGrades.map(g => {
            const heightPercent = g.score; // 满分100对应100%高度相对位置
            return `
                <div class="flex flex-col items-center flex-1 group relative cursor-pointer px-1">
                    <!-- 悬浮提示框 (反馈性原则) -->
                    <div class="absolute bottom-full mb-2 bg-slate-900 text-white text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 transition duration-150 pointer-events-none z-10 whitespace-nowrap">
                        分数: ${g.score} | 绩点: ${Math.max(0, (g.score - 50) / 10).toFixed(1)}
                    </div>
                    <!-- 动态高度柱条 -->
                    <div class="w-8 sm:w-10 bg-gradient-to-t from-blue-500 to-indigo-400 group-hover:from-blue-600 group-hover:to-indigo-500 rounded-t-md transition-all duration-500 ease-out shadow-sm" style="height: ${heightPercent}%"></div>
                    <!-- 轴文本标签 -->
                    <span class="text-[10px] text-slate-500 font-medium mt-2 text-center truncate w-full" title="${g.subject}">${g.subject}</span>
                </div>
            `;
        }).join('');
    }

    // 3. 动态更新饼图角度样式
    const pieCircle = document.getElementById('pie-chart-circle');
    const pieText = document.getElementById('pie-center-text');
    pieText.innerText = `${planCompletionRate}%`;
    pieCircle.style.background = `conic-gradient(#3b82f6 0% ${planCompletionRate}%, #f1f5f9 ${planCompletionRate}% 100%)`;
}

/* ==================== 7. 历史问答归档检索模块 ==================== */
function renderHistoryList() {
    const history = JSON.parse(localStorage.getItem('cm_history'));
    const searchKey = document.getElementById('history-search').value.toLowerCase().trim();
    const flowEl = document.getElementById('history-items-flow');

    const filtered = history.filter(item => 
        item.question.toLowerCase().includes(searchKey) || 
        item.answer.toLowerCase().includes(searchKey)
    );

    if(filtered.length === 0) {
        flowEl.innerHTML = `<div class="bg-white p-8 border border-dashed rounded-2xl text-center text-slate-400 text-xs">没有匹配到相关的历史问答记录档案</div>`;
        return;
    }

    flowEl.innerHTML = filtered.map(item => `
        <div class="bg-white border border-slate-200 rounded-2xl p-4 space-y-2 shadow-sm text-xs">
            <div class="flex justify-between items-center text-slate-400 border-b border-slate-50 pb-2">
                <span class="font-mono"><i class="fas fa-calendar-alt mr-1"></i>${item.timestamp}</span>
                <div class="flex items-center space-x-2">
                    <button onclick="reuseQuestion(\`${item.question.replace(/"/g, '&quot;')}\`)" class="text-blue-500 hover:underline"><i class="fas fa-copy mr-1"></i>复用问题</button>
                    <button onclick="deleteHistoryItem(${item.id})" class="text-slate-300 hover:text-rose-500 transition"><i class="fas fa-trash-alt"></i></button>
                </div>
            </div>
            <div>
                <div class="font-bold text-slate-900 mb-1">🤔 问题: ${item.question}</div>
                <div class="text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100 leading-relaxed">🤖 回答: ${item.answer}</div>
            </div>
        </div>
    `).join('');
}

function reuseQuestion(qText) {
    switchTab('ai-chat');
    document.getElementById('user-input').value = qText;
    document.getElementById('user-input').focus();
    showToast("问题已自动填入输入框，回车即可重新发送", "info");
}

function deleteHistoryItem(id) {
    const history = JSON.parse(localStorage.getItem('cm_history'));
    const remains = history.filter(h => h.id !== id);
    localStorage.setItem('cm_history', JSON.stringify(remains));
    showToast("单条记录已抹除", "info");
    renderHistoryList();
}

function triggerClearAllHistory() {
    openConfirmModal(
        "确定清空全部对话存档吗？",
        "此操作会将本地缓存的所有问答记录彻底清除，清空后无法找回。",
        () => {
            localStorage.setItem('cm_history', JSON.stringify([]));
            showToast("历史存储已全部被清空", "info");
            renderHistoryList();
        }
    );
}

// 默认进入 AI 助手 Tab 页面
switchTab('ai-chat');