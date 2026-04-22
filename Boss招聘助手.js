// ==UserScript==
// @name         Boss-招聘助手
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  Boss招聘工具 - 自动筛选候选人、自动打招呼、信息收集、简历下载、数据导出
// @author       ZhangGM
// @match        https://www.zhipin.com/shanghai/?seoRefer=index
// @match        https://www.zhipin.com/web/chat/recommend
// @match        https://www.zhipin.com/web/chat/index
// @icon         https://www.google.com/s2/favicons?sz=64&domain=zhipin.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        GM_getResourceText
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ==================== 全局配置 ====================
  const CONFIG = {
    COMPANY_NAME: "Boss",
    INTERVAL: 2000,           // 操作间隔（毫秒）
    SHORT_DELAY: 500,         // 短延迟
    MINI_ICON_SIZE: 40,
    MAX_CANDIDATES: 500,      // 最大收集候选人数
    POLL_INTERVAL: 30 * 60 * 1000,  // 轮询间隔（30分钟）
    STORAGE_KEYS: {
      CANDIDATES: "hengyu_candidates_v2",
      PROCESSED: "hengyu_processed_v2",
      SETTINGS: "hengyu_settings_v2",
      LAST_POLL: "hengyu_last_poll"
    }
  };

  // ==================== 存储管理 ====================
  const Storage = {
    get(key, defaultVal = null) {
      try {
        const val = GM_getValue(key);
        return val !== undefined ? val : defaultVal;
      } catch { return defaultVal; }
    },
    set(key, val) {
      try { GM_setValue(key, val); } catch {}
    },
    del(key) {
      try { GM_deleteValue(key); } catch {}
    },
    getJSON(key, defaultVal = []) {
      const val = this.get(key, defaultVal);
      return typeof val === "string" ? JSON.parse(val) : val;
    }
  };

  // ==================== 状态 ====================
  const state = {
    isRunning: false,
    isPolling: false,
    collectedCount: 0,
    greetedCount: 0,
    candidates: [],
    processedCandidateIds: new Set(),
    currentIndex: 0,
    // 当前页面类型
    pageType: null, // 'recommend' | 'chat'
    // 配置
    config: {
      targetCity: "",         // 目标城市
      greetLimit: 30,          // 招呼上限
      escortRequirements: "",  // 陪诊要求
      orderType: "普通单",     // 订单类型
      hospitalRequired: "否",  // 是否指定固定医院
      timeRange: "全部"       // 时间范围：全部/今日/近3日/近1周/近2周
    }
  };

  // ==================== 工具函数 ====================
  const Utils = {
    sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    },
    randomDelay(base, jitter = 0.3) {
      const delta = base * jitter;
      return base + Math.random() * delta * 2 - delta;
    },
    cleanText(str) {
      return (str || "").replace(/\s+/g, " ").trim();
    },
    generateId() {
      return Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    },
    formatDate() {
      return new Date().toLocaleString("zh-CN");
    },
    formatDateForFolder() {
      const d = new Date();
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}${month}${day}`;
    },
    getTodayFolderName() {
      return `${this.formatDateForFolder()}_陪诊`;
    },
    getDesktopPath() {
      // 尝试获取桌面路径
      return `${Environment.getDesktopDirectory ? Environment.getDesktopDirectory() : 'C:\\Users\\' + (Environment.UserName || 'User') + '\\Desktop'}`;
    },
    // 解析聊天列表中的时间字符串，返回 Date 或 null
    // 格式示例："04月13日"（今年）、"今天 14:30"、"昨天 10:00"、"n 04月13日"
    parseListTime(timeStr) {
      if (!timeStr) return null;
      const now = new Date();
      const thisYear = now.getFullYear();
      const todayStr = `${now.getMonth() + 1}月${now.getDate()}日`;
      const today = new Date(thisYear, now.getMonth(), now.getDate());

      // 去掉多余空白
      const text = timeStr.replace(/\s+/g, ' ').trim();

      // 今天 14:30
      if (text.startsWith('今天')) {
        const parts = text.split(/\s+/);
        if (parts[1]) {
          const [hh, mm] = parts[1].split(':').map(Number);
          const d = new Date(thisYear, now.getMonth(), now.getDate(), hh || 0, mm || 0);
          return d;
        }
        return today;
      }

      // 昨天 10:00
      if (text.startsWith('昨天')) {
        const parts = text.split(/\s+/);
        const d = new Date(thisYear, now.getMonth(), now.getDate() - 1);
        if (parts[1]) {
          const [hh, mm] = parts[1].split(':').map(Number);
          d.setHours(hh || 0, mm || 0);
        }
        return d;
      }

      // n 04月13日 格式（已沟通标记）
      const match = text.match(/(\d+)月(\d+)日/);
      if (match) {
        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        return new Date(thisYear, month - 1, day);
      }

      return null;
    },
    // 判断时间是否在指定范围内
    isWithinTimeRange(timeStr, range) {
      if (!range || range === '全部') return true;
      const date = this.parseListTime(timeStr);
      if (!date) return true; // 无法解析时默认通过

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      switch (range) {
        case '今日':
          return date.toDateString() === today.toDateString();
        case '近3日': {
          const threeDaysAgo = new Date(today);
          threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
          return date >= threeDaysAgo && date <= now;
        }
        case '近1周': {
          const weekAgo = new Date(today);
          weekAgo.setDate(weekAgo.getDate() - 7);
          return date >= weekAgo && date <= now;
        }
        case '近2周': {
          const twoWeeksAgo = new Date(today);
          twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
          return date >= twoWeeksAgo && date <= now;
        }
        default:
          return true;
      }
    }
  };

  // ==================== 跨 Frame 文档获取 ====================
  const TargetDoc = {
    get() {
      try {
        if (frames && frames[0] && frames[0].document) {
          const frameDoc = frames[0].document;
          // 简单验证是否是目标文档（有候选人卡片）
          if (frameDoc.querySelector && frameDoc.querySelector('.candidate-card-wrap')) {
            return frameDoc;
          }
        }
      } catch (e) {
        // cross-origin 或不可访问，降级到主文档
      }
      return document;
    },
    getFrame() {
      try {
        if (frames && frames[0]) return frames[0];
      } catch (e) {}
      return null;
    }
  };

  // ==================== 页面类型检测 ====================
  const PageDetector = {
    detect() {
      // 优先从 iframe 获取路径（iframe 和父窗口同源时可用）
      try {
        const frame = TargetDoc.getFrame();
        if (frame) {
          const path = frame.location.pathname;
          if (path.includes('/chat/recommend')) return 'recommend';
          if (path.includes('/chat/index')) return 'chat';
        }
      } catch (e) {
        // cross-origin iframe，无法访问，改用父窗口 URL
      }
      // 降级：使用父窗口 URL
      const path = window.location.pathname;
      if (path.includes('/chat/recommend')) return 'recommend';
      if (path.includes('/chat/index')) return 'chat';
      return null;
    }
  };

  // ==================== DOM 操作类 ====================
  class DOMHelper {
    // 等待元素出现
    static async waitForElement(selector, timeout = 10000) {
      const doc = TargetDoc.get();
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const element = doc.querySelector(selector);
        if (element) return element;
        await this.sleep(300);
      }
      return null;
    }

    // 等待元素出现（通过函数）
    static async waitForElementFn(fn, timeout = 10000) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const element = fn();
        if (element) return element;
        await this.sleep(300);
      }
      return null;
    }

    // 点击元素
    static async click(element) {
      if (!element) return false;
      element.click();
      await this.sleep(Utils.randomDelay(300));
      return true;
    }

    // 输入文本
    static async typeText(element, text) {
      if (!element) return false;
      element.focus();
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await this.sleep(Utils.randomDelay(200));
      return true;
    }

    // 滚动到元素可见
    static scrollIntoView(element) {
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    static sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    }
  };

  // ==================== 推荐牛人页面操作 ====================
  class RecommendPage {
    // 选择岗位（通过城市匹配）
    static async selectJobByCity(city) {
      const doc = TargetDoc.get();
      try {
        // 检查下拉框是否已打开（.ui-dropmenu-list 可见表示已打开）
        const dropdownAlreadyOpen = doc.querySelector('.job-selecter-wrap .ui-dropmenu-list');

        if (!dropdownAlreadyOpen) {
          // 点击岗位选择器打开下拉框
          const selector = doc.querySelector('.job-selecter-wrap .ui-dropmenu-label');
          if (!selector) {
            ui.log("未找到岗位选择器", "error");
            return false;
          }
          await DOMHelper.click(selector);
          await Utils.sleep(Utils.randomDelay(600));
        }

        // 找到输入框并搜索
        const searchInput = doc.querySelector('.job-selecter-wrap .chat-job-search');
        if (!searchInput) {
          ui.log("未找到岗位搜索输入框", "error");
          return false;
        }

        // 输入城市关键词
        await DOMHelper.typeText(searchInput, city);
        await Utils.sleep(Utils.randomDelay(1000));

        // 查找匹配的岗位项（包含"陪诊"和城市名）
        const jobItems = doc.querySelectorAll('.job-selecter-wrap .job-list .job-item');
        for (const item of jobItems) {
          const label = item.querySelector('.label');
          if (!label) continue;
          const text = label.textContent;
          if (text.includes('陪诊') && text.includes(city)) {
            await DOMHelper.click(item);
            ui.log(`已选择岗位: ${text}`, "success");
            await Utils.sleep(Utils.randomDelay(500));
            return true;
          }
        }

        // 如果没找到精确匹配的，尝试只匹配城市
        for (const item of jobItems) {
          const label = item.querySelector('.label');
          if (!label) continue;
          const text = label.textContent;
          if (text.includes(city)) {
            await DOMHelper.click(item);
            ui.log(`已选择岗位: ${text}`, "success");
            await Utils.sleep(Utils.randomDelay(500));
            return true;
          }
        }

        ui.log(`未找到包含"${city}"的陪诊岗位，将继续处理所有候选人`, "warn");
        // 关闭下拉菜单
        const closeBtn = doc.querySelector('.job-selecter-wrap .ui-dropmenu-label');
        if (closeBtn) await DOMHelper.click(closeBtn);
        return false;
      } catch (e) {
        ui.log(`选择岗位出错: ${e.message}`, "error");
        return false;
      }
    }

    // 筛选离职人员
    static async filterByUnemployed() {
      const doc = TargetDoc.get();
      try {
        // 点击筛选按钮
        const filterBtn = doc.querySelector('.filter-label');
        if (!filterBtn) {
          ui.log("未找到筛选按钮", "error");
          return false;
        }
        await DOMHelper.click(filterBtn);
        await Utils.sleep(Utils.randomDelay(800));

        // 等待筛选面板出现
        const filterPanel = await DOMHelper.waitForElementFn(() => doc.querySelector('.filter-panel'), 5000);
        if (!filterPanel) {
          ui.log("筛选面板未出现", "error");
          return false;
        }
        ui.log("筛选面板已打开", "info");

        // 查找"求职意向"整块区域，点击展开（如果需要）
        const intentionBox = doc.querySelector('.check-box.intention');
        if (intentionBox) {
          // 确保选项区域可见
          const optionsContainer = intentionBox.querySelector('.options');
          if (optionsContainer) {
            DOMHelper.scrollIntoView(optionsContainer);
            await Utils.sleep(200);
          }
        }

        // 查找"离职-随时到岗"选项
        let intentionOptions = [];
        for (let retry = 0; retry < 5; retry++) {
          intentionOptions = Array.from(doc.querySelectorAll('.check-box.intention .options .option'));
          if (intentionOptions.length > 0) break;
          await Utils.sleep(300);
        }

        ui.log(`找到 ${intentionOptions.length} 个求职意向选项`, "info");

        let found = false;
        for (const option of intentionOptions) {
          const text = option.textContent.trim();
          if (text.includes('离职') && text.includes('随时')) {
            // 滚动到选项并确保可见
            DOMHelper.scrollIntoView(option);
            await Utils.sleep(200);
            // 点击选项文字区域（更精准）
            const textEl = option.querySelector('span') || option;
            await DOMHelper.click(textEl);
            ui.log(`已点击: "${text}"`, "success");
            // 手动触发 change 事件
            option.dispatchEvent(new Event('change', { bubbles: true }));
            found = true;
            await Utils.sleep(Utils.randomDelay(300));
            break;
          }
        }

        if (!found) {
          ui.log("未找到离职筛选选项，关闭筛选面板", "warn");
          doc.body.click();
          return true;
        }

        // 点击"确定"按钮
        const confirmBtn = await DOMHelper.waitForElementFn(() => {
          const btns = doc.querySelectorAll('.filter-panel .btns .btn');
          for (const b of btns) {
            if (!b.classList.contains('btn-outline')) return b;
          }
          return null;
        }, 3000);
        if (confirmBtn) {
          DOMHelper.scrollIntoView(confirmBtn);
          await Utils.sleep(200);
          await DOMHelper.click(confirmBtn);
          ui.log("已点击确定按钮", "success");
          await Utils.sleep(Utils.randomDelay(1000));
        } else {
          ui.log("未找到确定按钮", "error");
          doc.body.click();
        }
        return true;
      } catch (e) {
        ui.log(`筛选离职人员出错: ${e.message}`, "error");
        return false;
      }
    }

    // 获取所有候选人卡片
    static getCandidateCards() {
      const doc = TargetDoc.get();
      const selectors = [
        '.candidate-card-wrap',
        '.geek-item',
        '.recommend-geek-item',
        '[class*="geek-item"]',
        '.candidate-item'
      ];

      for (const selector of selectors) {
        const items = doc.querySelectorAll(selector);
        if (items.length > 0) {
          return { items, selector };
        }
      }
      return { items: [], selector: null };
    }

    // 获取候选人信息
    static extractCandidateInfo(card) {
      try {
        // 优先从 data-geekid 获取ID
        const id = card.getAttribute('data-geekid') || card.getAttribute('data-geek') || card.getAttribute('data-id') || Utils.generateId();
        // 姓名
        const nameEl = card.querySelector('.name');
        // 当前工作经历（最近一份）
        const jobEl = card.querySelector('.work-exps .timeline-item .content span:last-child') ||
                       card.querySelector('.geek-desc, [class*="job"]');
        // 状态（暂无用到）
        const statusEl = card.querySelector('[class*="status"]');

        return {
          id: id,
          name: nameEl ? Utils.cleanText(nameEl.textContent) : '未知',
          currentJob: jobEl ? Utils.cleanText(jobEl.textContent) : '',
          status: statusEl ? Utils.cleanText(statusEl.textContent) : '',
          cardElement: card
        };
      } catch (e) {
        return null;
      }
    }

    // 对候选人打招呼
    static async greetCandidate(card) {
      try {
        const greetBtn = card.querySelector('.button-chat-wrap .btn-greet');
        if (!greetBtn) {
          // 降级：直接找 btn-greet
          const btn = card.querySelector('button.btn-greet');
          if (btn) {
            await DOMHelper.click(btn);
          } else {
            return false;
          }
          return true;
        }

        // 检查是否已经打过招呼
        if (greetBtn.disabled || greetBtn.textContent.includes('已')) {
          return false;
        }

        await DOMHelper.click(greetBtn);
        await Utils.sleep(Utils.randomDelay(800));
        return true;
      } catch (e) {
        return false;
      }
    }

    // 滚动加载更多候选人
    static async scrollToLoadMore() {
      const beforeCount = this.getCandidateCards().items.length;
      // 优先滚动 iframe 内部
      const frame = TargetDoc.getFrame();
      if (frame) {
        frame.scrollBy(0, 500);
      } else {
        window.scrollBy(0, 500);
      }
      await Utils.sleep(1500);
      const afterCount = this.getCandidateCards().items.length;
      return afterCount > beforeCount;
    }
  }

  // ==================== 沟通页面操作 ====================
  class ChatPage {
    // 获取聊天列表中的所有候选人
    static getChatList() {
      const doc = TargetDoc.get();
      const selectors = [
        '.geek-item',
        '.chat-geek-item',
        '[class*="geek-item"]',
        '.conversation-item'
      ];

      for (const selector of selectors) {
        const items = doc.querySelectorAll(selector);
        if (items.length > 0) {
          return { items, selector };
        }
      }
      return { items: [], selector: null };
    }

    // 提取候选人信息
    static extractCandidateInfo(item) {
      try {
        const id = item.getAttribute('data-id') || item.getAttribute('id') || '';
        const nameEl = item.querySelector('.geek-name, [class*="name"]');
        const jobEl = item.querySelector('.source-job, [class*="job"]');
        const timeEl = item.querySelector('.time, [class*="time"]');

        return {
          id: id.replace('_', ''),
          name: nameEl ? Utils.cleanText(nameEl.textContent) : '未知',
          currentJob: jobEl ? Utils.cleanText(jobEl.textContent) : '',
          lastActiveTime: timeEl ? Utils.cleanText(timeEl.textContent) : '',
          listItem: item
        };
      } catch (e) {
        return null;
      }
    }

    // 检查候选人是否与陪诊相关（只保留职位/姓名包含"陪诊"的候选人）
    static isAccompanimentRelated(candidateInfo) {
      const job = candidateInfo.currentJob || '';
      const name = candidateInfo.name || '';
      return job.includes('陪诊') || name.includes('陪诊');
    }

    // 点击进入聊天详情
    static async openChat(item) {
      try {
        const link = item.querySelector('a, [class*="link"]');
        if (link) {
          await DOMHelper.click(link);
        } else {
          await DOMHelper.click(item);
        }
        await Utils.sleep(Utils.randomDelay(1500));
        return true;
      } catch (e) {
        return false;
      }
    }

    // 获取聊天输入框
    static getChatInput() {
      const doc = TargetDoc.get();
      const selectors = [
        '#chat-input',
        '.chat-input textarea',
        'textarea[class*="chat"]',
        '[class*="chat-input"] textarea'
      ];

      for (const selector of selectors) {
        const input = doc.querySelector(selector);
        if (input) return input;
      }
      return null;
    }

    // 获取发送按钮
    static getSendButton() {
      const doc = TargetDoc.get();
      const selectors = [
        '.btn-send',
        'button[class*="send"]',
        '[class*="send-btn"]'
      ];

      for (const selector of selectors) {
        const btn = doc.querySelector(selector);
        if (btn) return btn;
      }
      return null;
    }

    // 发送消息
    static async sendMessage(text) {
      try {
        const input = this.getChatInput();
        if (!input) {
          ui.log("未找到聊天输入框", "error");
          return false;
        }

        await DOMHelper.typeText(input, text);
        await Utils.sleep(Utils.randomDelay(300));

        const sendBtn = this.getSendButton();
        if (sendBtn) {
          await DOMHelper.click(sendBtn);
          ui.log(`已发送消息`, "success");
          await Utils.sleep(Utils.randomDelay(800));
          return true;
        }

        // 尝试按Enter发送
        input.focus();
        const enterEvent = new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        input.dispatchEvent(enterEvent);
        await Utils.sleep(Utils.randomDelay(500));
        return true;
      } catch (e) {
        ui.log(`发送消息出错: ${e.message}`, "error");
        return false;
      }
    }

    // 获取"求简历"按钮
    static getRequestResumeBtn() {
      const doc = TargetDoc.get();
      const btns = doc.querySelectorAll('.operate-icon-item .operate-btn');
      for (const btn of btns) {
        if (btn.textContent.trim() === '求简历') {
          return btn.closest('.operate-icon-item');
        }
      }
      return null;
    }

    // 点击"求简历"按钮
    static async clickRequestResume() {
      const doc = TargetDoc.get();
      try {
        const btn = this.getRequestResumeBtn();
        if (!btn) {
          ui.log("未找到'求简历'按钮", "error");
          return false;
        }

        await DOMHelper.click(btn);
        await Utils.sleep(Utils.randomDelay(500));

        // 确认对话框
        const confirmBtn = doc.querySelector('.exchange-tooltip .boss-btn-primary');
        if (confirmBtn) {
          await DOMHelper.click(confirmBtn);
          ui.log("已发送简历请求", "success");
          await Utils.sleep(Utils.randomDelay(800));
          return true;
        }

        return true;
      } catch (e) {
        ui.log(`求简历操作出错: ${e.message}`, "error");
        return false;
      }
    }

    // 获取"附件简历"按钮
    static getResumeBtn() {
      const doc = TargetDoc.get();
      return doc.querySelector('a.resume-btn-file, [class*="resume-btn"]');
    }

    // 点击附件简历按钮
    static async clickResumeBtn() {
      try {
        const btn = this.getResumeBtn();
        if (!btn) {
          ui.log("未找到'附件简历'按钮", "error");
          return false;
        }

        await DOMHelper.click(btn);
        await Utils.sleep(Utils.randomDelay(1000));
        return true;
      } catch (e) {
        ui.log(`点击简历按钮出错: ${e.message}`, "error");
        return false;
      }
    }

    // 获取下载按钮并下载简历
    static async downloadResume(candidateName = '未知') {
      const doc = TargetDoc.get();
      try {
        // 查找下载按钮
        const downloadIcon = doc.querySelector('.attachment-resume-btns .popover .svg-icon use[href*="download"]');
        if (downloadIcon) {
          const downloadBtn = downloadIcon.closest('.popover');
          if (downloadBtn) {
            await DOMHelper.click(downloadBtn);
            ui.log(`已下载简历: ${candidateName}`, "success");
            await Utils.sleep(Utils.randomDelay(1000));
            return true;
          }
        }

        // 尝试直接点击下载图标
        const downloadBtns = doc.querySelectorAll('[class*="download"]');
        for (const btn of downloadBtns) {
          if (btn.offsetParent !== null) { // 检查是否可见
            await DOMHelper.click(btn);
            ui.log(`已点击下载按钮: ${candidateName}`, "success");
            await Utils.sleep(Utils.randomDelay(1000));
            return true;
          }
        }

        ui.log("未找到简历下载按钮", "error");
        return false;
      } catch (e) {
        ui.log(`下载简历出错: ${e.message}`, "error");
        return false;
      }
    }

    // 获取候选人对话中的最新消息
    static getLatestMessages(count = 5) {
      const doc = TargetDoc.get();
      const messages = [];
      const selectors = [
        '.im-list li.message-item',
        '.chat-message .im-list li',
        '[class*="message-item"]'
      ];

      let messageContainer = null;
      for (const selector of selectors) {
        messageContainer = doc.querySelector(selector);
        if (messageContainer) break;
      }

      if (!messageContainer) return messages;

      const allMessages = doc.querySelectorAll(selectors[0]) || [];
      return Array.from(allMessages).slice(-count);
    }

    // 检查HR是否有新回复
    static hasNewMessage() {
      const messages = this.getLatestMessages(2);
      if (messages.length === 0) return false;

      const lastMessage = messages[messages.length - 1];
      // 检查是否是自己的消息（item-friend是对方，item-self是自己）
      return !lastMessage.classList.contains('item-self');
    }

    // 收藏候选人（通过页面上的收藏按钮）
    static async favoriteCandidate() {
      const doc = TargetDoc.get();
      try {
        // 方案1：SVG icon
        const favoriteIcon = doc.querySelector('use[href="#icon-chat-star"]');
        if (favoriteIcon) {
          const parent = favoriteIcon.closest('[class*="star"], .operate-icon-item, button, a, div');
          if (parent) {
            await DOMHelper.click(parent);
            ui.log("已收藏候选人 (SVG)", "success");
            await Utils.sleep(Utils.randomDelay(500));
            return true;
          }
          const parentEl = favoriteIcon.parentElement;
          if (parentEl && (parentEl.tagName === 'BUTTON' || parentEl.tagName === 'DIV' || parentEl.tagName === 'A')) {
            await DOMHelper.click(parentEl);
            ui.log("已收藏候选人 (SVG父)", "success");
            await Utils.sleep(Utils.randomDelay(500));
            return true;
          }
        }

        // 方案2：data属性
        const dataBtn = doc.querySelector('[data-type="star"], [class*="favorite"], [class*="collect"]');
        if (dataBtn) {
          await DOMHelper.click(dataBtn);
          ui.log("已收藏候选人 (data)", "success");
          await Utils.sleep(Utils.randomDelay(500));
          return true;
        }

        // 方案3：文本匹配
        const allBtns = doc.querySelectorAll('button, a, [class*="btn"]');
        for (const btn of allBtns) {
          const text = (btn.textContent || '').trim();
          if (text.includes('收藏') || text.includes('★')) {
            await DOMHelper.click(btn);
            ui.log("已收藏候选人 (文本)", "success");
            await Utils.sleep(Utils.randomDelay(500));
            return true;
          }
        }

        ui.log("未找到收藏按钮", "warn");
        return false;
      } catch (e) {
        ui.log(`收藏操作出错: ${e.message}`, "error");
        return false;
      }
    }

    // 返回聊天列表
    static async backToList() {
      const doc = TargetDoc.get();
      try {
        const backBtn = doc.querySelector('.chat-back, .back-btn, [class*="back"]');
        if (backBtn) {
          await DOMHelper.click(backBtn);
        } else {
          history.back();
        }
        await Utils.sleep(Utils.randomDelay(1500));
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  // ==================== Dify Agent 接口 ====================
  class DifyAgent {
    static BASE_URL = "http://192.168.31.20:6080/v1";
    static CHAT_AGENT_KEY = "app-cZouV7tO88rbNEncjCjIWiDj";

    // 发送聊天消息给对话agent，获取AI回复
    static async getChatReply(userMessage, escortRequirements = '', orderType = '', hospitalRequired = '') {
      try {
        ui.log(`[Dify] 发送消息到对话agent...`, "info");
        const resp = await this._postChat(
          `${this.BASE_URL}/chat-messages`,
          this.CHAT_AGENT_KEY,
          userMessage,
          {
            info: escortRequirements,
            orderType: orderType,
            hospitalRequired: hospitalRequired
          }
        );
        ui.log(`[Dify] 对话agent回复: ${resp.answer.substring(0, 50)}...`, "success");
        return resp.answer;
      } catch (e) {
        ui.log(`[Dify] 对话agent出错: ${e.message}`, "error");
        throw e;
      }
    }

    static _postChat(url, apiKey, query, inputs) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: url,
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          data: JSON.stringify({
            query,
            inputs,
            response_mode: "blocking",
            user: "hengyu-assistant"
          }),
          timeout: 60000,
          onload(resp) {
            if (resp.status >= 200 && resp.status < 300) {
              try {
                const data = JSON.parse(resp.responseText);
                if (data.answer) {
                  resolve(data);
                } else {
                  reject(new Error("响应缺少 answer 字段: " + resp.responseText.substring(0, 200)));
                }
              } catch (e) {
                reject(new Error("解析响应失败: " + e.message));
              }
            } else {
              reject(new Error(`请求失败: ${resp.status} ${resp.statusText} - ${resp.responseText.substring(0, 200)}`));
            }
          },
          onerror(err) { reject(new Error("请求错误: " + (err.message || err))); },
          ontimeout() { reject(new Error("请求超时（60秒）")); }
        });
      });
    }
  }

  // ==================== 消息监听 ====================
  class MessageMonitor {
    // 检查是否有新消息 badge
    static hasUnreadBadge() {
      const doc = TargetDoc.get();
      const badge = doc.querySelector('span.badge-count span');
      return !!(badge && badge.textContent.trim());
    }

    // 获取 HR 的最新一条消息
    static getLatestHRMessage() {
      const doc = TargetDoc.get();
      const items = doc.querySelectorAll('.conversation-message .message-item');
      // 从后往前找，找没有 .item-friend 的（HR发的，或者时间卡片不算）
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const friendDiv = item.querySelector('.item-friend');
        const textEl = item.querySelector('.text span');
        if (friendDiv || !textEl) continue; // 跳过候选人消息和时间卡片
        const text = Utils.cleanText(textEl.textContent);
        if (text) return text;
      }
      return '';
    }

    // 获取候选人的最新一条消息
    static getLatestCandidateMessage() {
      const doc = TargetDoc.get();
      const items = doc.querySelectorAll('.conversation-message .message-item');
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const friendDiv = item.querySelector('.item-friend');
        if (!friendDiv) continue;
        const textEl = item.querySelector('.text span');
        return textEl ? Utils.cleanText(textEl.textContent) : '';
      }
      return '';
    }

    // 收集当前对话的所有消息，格式：HR：[消息]；候选人：[消息]；
    static collectChatHistory() {
      const doc = TargetDoc.get();
      const items = doc.querySelectorAll('.conversation-message .message-item');
      const lines = [];
      for (const item of items) {
        // .item-self 是 HR 发的，.item-friend 是候选人发的（内层div）
        const isSelf = item.querySelector(':scope > .item-self').length > 0;
        const isFriend = item.querySelector(':scope > .item-friend').length > 0;
        const textEl = item.querySelector('.text span');
        if (!textEl) continue;
        const text = Utils.cleanText(textEl.textContent);
        if (text) {
          lines.push((isSelf ? 'HR' : '候选人') + '：' + text);
        }
      }
      return lines.join('；') + '。';
    }
  }

  // ==================== UI 管理 ====================
  class UI {
    constructor() {
      this.panel = null;
      this.isMinimized = false;
      this.injectStyles();
    }

    injectStyles() {
      GM_addStyle(`
        #hengyu-panel * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }

        /* === Design System === */
        :root {
          --hy-primary: #0F172A;
          --hy-secondary: #3B82F6;
          --hy-accent: #10B981;
          --hy-bg: #F8FAFC;
          --hy-fg: #0F172A;
          --hy-muted: #F1F5F9;
          --hy-border: #E2E8F0;
          --hy-destructive: #EF4444;
          --hy-text-secondary: #64748B;
          --hy-success: #10B981;
          --hy-warning: #F59E0B;
          --hy-required: #EF4444;
        }

        /* === Panel === */
        #hengyu-panel {
          position: fixed;
          top: 80px;
          right: 16px;
          width: 320px;
          background: #fff;
          border: 1px solid var(--hy-border);
          border-radius: 16px;
          z-index: 99999;
          font-size: 13px;
          transition: box-shadow 0.2s ease;
          max-height: 88vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 4px 24px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
          visibility: visible;
        }
        #hengyu-panel.minimized { display: none; }
        #hengyu-panel.dragging { box-shadow: 0 12px 40px rgba(0,0,0,0.16), 0 2px 4px rgba(0,0,0,0.08); }

        /* === Header === */
        #hengyu-panel .hengyu-header {
          background: linear-gradient(135deg, #0F172A 0%, #1E293B 100%);
          color: white;
          padding: 14px 16px;
          border-radius: 14px 14px 0 0;
          cursor: grab;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-shrink: 0;
          user-select: none;
        }
        #hengyu-panel.minimized .hengyu-header { border-radius: 14px 14px 0 0; cursor: grab; }
        #hengyu-panel .hengyu-header:active { cursor: grabbing; }
        #hengyu-panel .hengyu-header h3 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
        #hengyu-panel .hengyu-header .header-badge { font-size: 10px; background: rgba(255,255,255,0.15); padding: 2px 8px; border-radius: 10px; margin-left: 8px; font-weight: 500; }

        /* === Body === */
        #hengyu-panel .hengyu-body { padding: 0; flex: 1; overflow-y: auto; background: var(--hy-bg); }

        /* === Page Indicator === */
        .hy-page-indicator {
          background: #fff;
          border-bottom: 1px solid var(--hy-border);
          padding: 10px 16px;
          font-size: 12px;
          color: var(--hy-text-secondary);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .hy-page-indicator .dot { width: 7px; height: 7px; border-radius: 50%; background: #CBD5E1; flex-shrink: 0; }
        .hy-page-indicator.active .dot { background: var(--hy-accent); box-shadow: 0 0 0 3px rgba(16,185,129,0.2); }
        .hy-page-indicator .page-name { color: var(--hy-fg); font-weight: 500; }

        /* === Stats Grid === */
        .hy-stats { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid var(--hy-border); background: #fff; }
        .hy-stat { padding: 14px 8px; text-align: center; border-right: 1px solid var(--hy-border); }
        .hy-stat:last-child { border-right: none; }
        .hy-stat .num { font-size: 26px; font-weight: 700; color: var(--hy-primary); line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
        .hy-stat .num.success { color: var(--hy-success); }
        .hy-stat .num.warning { color: var(--hy-warning); }
        .hy-stat .txt { font-size: 10px; color: var(--hy-text-secondary); margin-top: 4px; font-weight: 500; letter-spacing: 0.02em; }

        /* === Tip === */
        .hy-tip {
          background: linear-gradient(135deg, #FFFBEB 0%, #FEF3C7 100%);
          border: none;
          border-left: 3px solid var(--hy-warning);
          margin: 12px;
          padding: 10px 12px;
          font-size: 11px;
          color: #92400E;
          line-height: 1.6;
          border-radius: 0 8px 8px 0;
        }

        /* === Collapsible Sections === */
        .hy-section { border-bottom: 1px solid var(--hy-border); }
        .hy-section:last-child { border-bottom: none; }
        .hy-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #fff; cursor: pointer; user-select: none; }
        .hy-section-header:hover { background: var(--hy-muted); }
        .hy-section-title { font-size: 12px; font-weight: 600; color: var(--hy-fg); letter-spacing: 0.02em; }
        .hy-section-toggle { font-size: 11px; color: var(--hy-text-secondary); transition: transform 0.2s; }
        .hy-section.collapsed .hy-section-toggle { transform: rotate(-90deg); }
        .hy-section-body { padding: 14px 16px; background: #fff; }
        .hy-section.collapsed .hy-section-body { display: none; }

        /* === Form Elements === */
        .hy-field { margin-bottom: 14px; }
        .hy-field:last-child { margin-bottom: 0; }
        .hy-field label { display: flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; color: var(--hy-fg); margin-bottom: 5px; }
        .hy-field label .required-star { color: var(--hy-required); font-size: 13px; line-height: 1; }
        .hy-field .field-sub { font-size: 10px; color: var(--hy-text-secondary); font-weight: 400; margin-left: 2px; }
        .hy-field input, .hy-field textarea, .hy-field select {
          width: 100%;
          padding: 9px 12px;
          border: 1.5px solid var(--hy-border);
          border-radius: 8px;
          font-size: 13px;
          color: var(--hy-fg);
          background: #fff;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .hy-field input:focus, .hy-field textarea:focus {
          outline: none;
          border-color: var(--hy-secondary);
          box-shadow: 0 0 0 3px rgba(59,130,246,0.12);
        }
        .hy-field input:invalid:not(:placeholder-shown),
        .hy-field textarea:invalid:not(:placeholder-shown) {
          border-color: #FCA5A5;
          background: #FEF2F2;
        }
        .hy-field input::placeholder, .hy-field textarea::placeholder { color: #CBD5E1; }
        .hy-field textarea { height: 90px; resize: vertical; line-height: 1.6; }
        .hy-field .hint { font-size: 10px; color: var(--hy-text-secondary); margin-top: 4px; line-height: 1.5; }

        /* === Radio Buttons === */
        .hy-radio-group { display: flex; gap: 16px; margin-top: 4px; }
        .hy-radio { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; font-weight: 400; color: var(--hy-fg); }
        .hy-radio input[type="radio"] { width: 16px; height: 16px; accent-color: var(--hy-secondary); cursor: pointer; }
        .hy-radio span { user-select: none; }

        /* === Buttons === */
        .hy-footer { padding: 12px 14px 14px; background: #fff; border-top: 1px solid var(--hy-border); display: flex; flex-direction: column; gap: 8px; }
        .hy-btn { width: 100%; padding: 11px 16px; border: none; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 13px; transition: all 0.15s; display: flex; align-items: center; justify-content: center; gap: 6px; letter-spacing: 0.01em; }
        .hy-btn:active { transform: scale(0.97); }
        .hy-btn-primary { background: linear-gradient(135deg, #3B82F6 0%, #2563EB 100%); color: white; box-shadow: 0 2px 8px rgba(59,130,246,0.3); }
        .hy-btn-primary:hover { box-shadow: 0 4px 12px rgba(59,130,246,0.4); }
        .hy-btn-primary:disabled { background: #CBD5E1; box-shadow: none; cursor: not-allowed; }
        .hy-btn-success { background: linear-gradient(135deg, #10B981 0%, #059669 100%); color: white; box-shadow: 0 2px 8px rgba(16,185,129,0.3); }
        .hy-btn-success:hover { box-shadow: 0 4px 12px rgba(16,185,129,0.4); }
        .hy-btn-secondary { background: var(--hy-muted); color: var(--hy-fg); border: 1px solid var(--hy-border); }
        .hy-btn-secondary:hover { background: #E2E8F0; }
        .hy-btn-danger { background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); color: white; box-shadow: 0 2px 8px rgba(239,68,68,0.3); }
        .hy-btn-danger:hover { box-shadow: 0 4px 12px rgba(239,68,68,0.4); }
        .hy-btn-row { display: flex; gap: 8px; }
        .hy-btn-row .hy-btn { flex: 1; }

        /* === Progress Bar === */
        .hy-progress { height: 3px; background: var(--hy-border); border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
        .hy-progress-bar { height: 100%; background: linear-gradient(90deg, #3B82F6, #2563EB); transition: width 0.3s ease; border-radius: 2px; }
        .hy-progress-bar.success { background: linear-gradient(90deg, #10B981, #059669); }
        .hy-status { font-size: 11px; color: var(--hy-text-secondary); text-align: center; margin-bottom: 8px; }

        /* === Log === */
        .hy-log { background: var(--hy-muted); border: 1px solid var(--hy-border); border-radius: 8px; padding: 8px; height: 96px; overflow-y: auto; font-size: 11px; color: var(--hy-text-secondary); line-height: 1.7; }
        .hy-log .log-item { padding: 2px 0; }
        .hy-log .log-time { color: #94A3B8; margin-right: 6px; font-variant-numeric: tabular-nums; }
        .hy-log .log-success { color: var(--hy-success); }
        .hy-log .log-error { color: var(--hy-destructive); }
        .hy-log .log-info { color: var(--hy-secondary); }
        .hy-log .log-warn { color: var(--hy-warning); }

        /* === Mini Expand Button (Floating) === */
        #hengyu-mini-btn {
          position: fixed;
          top: 80px;
          right: 16px;
          width: 48px;
          height: 48px;
          background: linear-gradient(135deg, #0F172A 0%, #1E293B 100%);
          border-radius: 50%;
          cursor: pointer;
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 2px solid rgba(255,255,255,0.15);
          box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 1px 3px rgba(0,0,0,0.12);
          user-select: none;
          transition: transform 0.15s, box-shadow 0.15s;
          visibility: hidden;
        }
        #hengyu-mini-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
        #hengyu-mini-btn:active { transform: scale(0.95); }
        #hengyu-mini-btn.dragging { cursor: grabbing; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
        
        /* === Scrollbar === */
        #hengyu-panel .hengyu-body::-webkit-scrollbar { width: 5px; }
        #hengyu-panel .hengyu-body::-webkit-scrollbar-track { background: transparent; }
        #hengyu-panel .hengyu-body::-webkit-scrollbar-thumb { background: #CBD5E1; border-radius: 3px; }
        #hengyu-panel .hengyu-body::-webkit-scrollbar-thumb:hover { background: #94A3B8; }
      `);
    }

    render() {
      const requirementsEscaped = this.escapeHtml(state.config.escortRequirements || "");

      const html = `
        <div class="hengyu-header" id="hengyu-drag">
          <div style="display:flex;align-items:center;">
            <h3>Boss招聘</h3>
            <span class="header-badge">v2.1</span>
          </div>
          <span id="hengyu-toggle-btn" style="cursor:pointer;font-size:16px;opacity:0.8;user-select:none;">−</span>
        </div>
        <div class="hengyu-body">
          <div class="hy-page-indicator" id="hengyu-page-info">
            <span class="dot"></span>
            <span>页面：<span class="page-name" id="hengyu-current-page">检测中...</span></span>
          </div>

          <div class="hy-stats">
            <div class="hy-stat">
              <div class="num" id="hengyu-count">0</div>
              <div class="txt">已收集</div>
            </div>
            <div class="hy-stat">
              <div class="num success" id="hengyu-greeted">0</div>
              <div class="txt">已招呼</div>
            </div>
            <div class="hy-stat">
              <div class="num warning" id="hengyu-processed">0</div>
              <div class="txt">已处理</div>
            </div>
          </div>

          <div class="hy-tip" id="hengyu-tip">
            1. 进入"推荐候选人"页面，点击"开始收集"筛选候选人并发送招呼。2. 进入"消息"页面，点击"开始沟通"收集回复的候选人简历。非陪诊候选人会被自动跳过。
          </div>

          <!-- Basic Settings Section -->
          <div class="hy-section" id="hy-section-basic">
            <div class="hy-section-header" onclick="document.getElementById('hy-section-basic').classList.toggle('collapsed')">
              <span class="hy-section-title">基本设置</span>
              <span class="hy-section-toggle">▼</span>
            </div>
            <div class="hy-section-body">
              <div class="hy-field">
                <label><span class="required-star">*</span>目标城市<span class="field-sub"> / 招聘所在城市</span></label>
                <input type="text" id="hengyu-city" placeholder="例如：上海、北京、杭州" required>
              </div>
              <div class="hy-field">
                <label><span class="required-star">*</span>招呼上限<span class="field-sub"> / 自动停止阈值</span></label>
                <input type="number" id="hengyu-greet-limit" value="${state.config.greetLimit || 30}" min="1" max="100" required>
              </div>
              <div class="hy-field">
                <label><span class="required-star">*</span>时间范围</label>
                <div class="hy-radio-group" id="hengyu-time-range">
                  <label class="hy-radio"><input type="radio" name="hengyu-time-range" value="全部" id="hengyu-time-all"> <span>全部</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-time-range" value="今日" id="hengyu-time-today"> <span>今日</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-time-range" value="近3日" id="hengyu-time-3d"> <span>近3日</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-time-range" value="近1周" id="hengyu-time-1w"> <span>近1周</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-time-range" value="近2周" id="hengyu-time-2w"> <span>近2周</span></label>
                </div>
              </div>
            </div>
          </div>

          <!-- Escort Requirements Section -->
          <div class="hy-section" id="hy-section-requirements">
            <div class="hy-section-header" onclick="document.getElementById('hy-section-requirements').classList.toggle('collapsed')">
              <span class="hy-section-title">陪诊要求</span>
              <span class="hy-section-toggle">▼</span>
            </div>
            <div class="hy-section-body">
              <div class="hy-field">
                <label><span class="required-star">*</span>具体要求<span class="field-sub"> / 发送给AI生成消息</span></label>
                <textarea id="hengyu-requirements" style="height:100px;" placeholder="就诊日期：&#10;就诊城市：&#10;就诊医院：&#10;就诊院区：&#10;就诊地址：&#10;就诊科室：" required>${requirementsEscaped}</textarea>
                <div class="hint">填写陪诊任务的具体信息，用于AI生成个性化沟通内容</div>
              </div>
              <div class="hy-field">
                <label><span class="required-star">*</span>订单类型</label>
                <div class="hy-radio-group">
                  <label class="hy-radio"><input type="radio" name="hengyu-order-type" value="急单" id="hengyu-order-urgent"> <span>急单</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-order-type" value="普通单" id="hengyu-order-normal" checked> <span>普通单</span></label>
                </div>
              </div>
              <div class="hy-field">
                <label><span class="required-star">*</span>本单是否指定固定医院</label>
                <div class="hy-radio-group">
                  <label class="hy-radio"><input type="radio" name="hengyu-hospital" value="是" id="hengyu-hospital-yes"> <span>是</span></label>
                  <label class="hy-radio"><input type="radio" name="hengyu-hospital" value="否" id="hengyu-hospital-no" checked> <span>否</span></label>
                </div>
              </div>
            </div>
          </div>

          <!-- Log Section -->
          <div class="hy-section" id="hy-section-log">
            <div class="hy-section-header" onclick="document.getElementById('hy-section-log').classList.toggle('collapsed')">
              <span class="hy-section-title">操作日志</span>
              <span class="hy-section-toggle">▼</span>
            </div>
            <div class="hy-section-body">
              <div class="hy-log" id="hengyu-log"></div>
            </div>
          </div>
        </div>

        <div class="hy-footer" id="hengyu-actions">
          <div class="hy-progress" id="hy-progress" style="display:none;">
            <div class="hy-progress-bar" id="hy-progress-bar" style="width:0%"></div>
          </div>
          <div class="hy-status" id="hy-status" style="display:none;"></div>

          <div class="hy-btn-row">
            <button class="hy-btn hy-btn-primary" id="hengyu-start">开始收集</button>
            <button class="hy-btn hy-btn-success" id="hengyu-start-chat">开始沟通</button>
          </div>
          <button class="hy-btn hy-btn-secondary" id="hengyu-export">导出数据</button>
          <button class="hy-btn hy-btn-danger" id="hengyu-stop" style="display:none;">停止</button>
        </div>
      `;

      this.panel = document.createElement("div");
      this.panel.id = "hengyu-panel";
      this.panel.innerHTML = html;
      document.body.appendChild(this.panel);

      // Separate mini expand button (only visible when minimized)
      const miniBtn = document.createElement("div");
      miniBtn.id = "hengyu-mini-btn";
      miniBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="16" height="16" rx="4" stroke="white" stroke-width="2" fill="none"/>
        <path d="M7 10H13M10 7V13" stroke="white" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
      miniBtn.title = "点击展开";
      document.body.appendChild(miniBtn);

      this.miniBtn = miniBtn;
      this.bindEvents();
      this.loadState();
      this.updatePageIndicator();
    }

    escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    bindEvents() {
      // Toggle minimize
      document.getElementById("hengyu-toggle-btn").onclick = () => this.toggle();
      // Mini button click to expand
      this.miniBtn.onclick = () => this.toggle();

      // Drag — panel
      this.initDrag("hengyu-drag");
      // Drag — mini button (when minimized, drag the mini button)
      this.initDrag("hengyu-mini-btn");

      // Start collection (recommend page)
      document.getElementById("hengyu-start").onclick = () => this.startCollect();

      // Start chat (chat page)
      document.getElementById("hengyu-start-chat").onclick = () => this.startChat();

      // Stop
      document.getElementById("hengyu-stop").onclick = () => this.stop();

      // Export
      document.getElementById("hengyu-export").onclick = () => this.exportData();

      // Save config on input change
      ["city", "greet-limit", "requirements"].forEach(id => {
        const el = document.getElementById(`hengyu-${id}`);
        if (el) {
          el.onchange = () => this.saveConfig();
          el.oninput = () => this.saveConfig();
        }
      });
      // Radio button change handlers
      document.querySelectorAll('input[name="hengyu-order-type"], input[name="hengyu-hospital"], input[name="hengyu-time-range"]').forEach(el => {
        el.onchange = () => this.saveConfig();
      });
    }

    initDrag(handleId) {
      const handle = document.getElementById(handleId);
      if (!handle) return;

      const isPanel = handleId === "hengyu-drag";
      let isDragging = false;
      let startX, startY, startLeft, startTop;
      const DRAG_THRESHOLD = 5;

      const onMouseDown = (e) => {
        if (e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        const dragTarget = isPanel ? this.panel : this.miniBtn;
        const rect = dragTarget.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        isDragging = false;
        e.preventDefault();
      };

      const onMouseMove = (e) => {
        if (startX === undefined) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const dragTarget = isPanel ? this.panel : this.miniBtn;

        if (!isDragging && dist > DRAG_THRESHOLD) {
          isDragging = true;
          dragTarget.classList.add("dragging");
          dragTarget.style.right = "auto";
        }

        if (!isDragging) return;
        const newLeft = Math.max(0, startLeft + dx);
        const newTop = Math.max(0, Math.min(window.innerHeight - dragTarget.offsetHeight, startTop + dy));
        dragTarget.style.left = newLeft + "px";
        dragTarget.style.top = newTop + "px";
      };

      const onMouseUp = () => {
        const dragTarget = isPanel ? this.panel : this.miniBtn;
        if (isDragging) {
          dragTarget.classList.remove("dragging");
        }
        isDragging = false;
        startX = startY = undefined;
      };

      handle.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }

    toggle() {
      const isMinimizing = !this.panel.classList.contains("minimized");
      this.panel.classList.toggle("minimized");

      if (isMinimizing) {
        // Save current panel position before hiding
        const rect = this.panel.getBoundingClientRect();
        this._lastPanelLeft = rect.left;
        this._lastPanelTop = rect.top;
        this.panel.style.visibility = "hidden";

        // Position and show the mini expand button
        const miniBtn = this.miniBtn;
        miniBtn.style.left = rect.left + "px";
        miniBtn.style.top = rect.top + "px";
        miniBtn.style.right = "auto";
        miniBtn.style.visibility = "visible";
      } else {
        // Hide mini button, restore panel
        this.miniBtn.style.visibility = "hidden";
        this.panel.style.visibility = "visible";

        // Restore to last position or default right side
        if (this._lastPanelLeft !== undefined) {
          this.panel.style.left = this._lastPanelLeft + "px";
          this.panel.style.top = this._lastPanelTop + "px";
          this.panel.style.right = "auto";
        }
      }
    }

    log(msg, type = "info") {
      const logEl = document.getElementById("hengyu-log");
      if (!logEl) return;
      const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const item = document.createElement("div");
      item.className = `log-item log-${type}`;
      item.innerHTML = `<span class="log-time">[${time}]</span>${this.escapeHtml(msg)}`;
      logEl.insertBefore(item, logEl.firstChild);
      while (logEl.children.length > 100) logEl.removeChild(logEl.lastChild);
    }

    updateCount(collected, greeted, processed) {
      const countEl = document.getElementById("hengyu-count");
      const greetedEl = document.getElementById("hengyu-greeted");
      const processedEl = document.getElementById("hengyu-processed");
      if (countEl) countEl.textContent = collected;
      if (greetedEl) greetedEl.textContent = greeted;
      if (processedEl) processedEl.textContent = processed;
    }

    updateProgress(current, total, label) {
      const progressEl = document.getElementById("hy-progress");
      const barEl = document.getElementById("hy-progress-bar");
      const statusEl = document.getElementById("hy-status");
      if (progressEl && barEl && statusEl) {
        progressEl.style.display = "block";
        statusEl.style.display = "block";
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        barEl.style.width = pct + "%";
        statusEl.textContent = `${label}: ${current}/${total} (${pct}%)`;
      }
    }

    hideProgress() {
      const progressEl = document.getElementById("hy-progress");
      const statusEl = document.getElementById("hy-status");
      if (progressEl) progressEl.style.display = "none";
      if (statusEl) statusEl.style.display = "none";
    }

    updatePageIndicator() {
      const page = PageDetector.detect();
      state.pageType = page;
      const pageEl = document.getElementById("hengyu-current-page");
      const pageInfo = document.getElementById("hengyu-page-info");
      if (pageEl) {
        const pageNames = {
          'recommend': 'Recommend Page',
          'chat': 'Messages Page'
        };
        pageEl.textContent = pageNames[page] || 'Unknown Page';
      }
      if (pageInfo) {
        pageInfo.classList.toggle('active', !!page);
      }

      // Update button visibility
      const startBtn = document.getElementById("hengyu-start");
      const startChatBtn = document.getElementById("hengyu-start-chat");
      const tipEl = document.getElementById("hengyu-tip");

      if (page === 'recommend') {
        if (startBtn) startBtn.style.display = 'flex';
        if (startChatBtn) startChatBtn.style.display = 'none';
        if (tipEl) tipEl.textContent = '在推荐候选人页面，点击"开始收集"筛选候选人并发送招呼。';
      } else if (page === 'chat') {
        if (startBtn) startBtn.style.display = 'none';
        if (startChatBtn) startChatBtn.style.display = 'flex';
        if (tipEl) tipEl.textContent = '在消息页面，点击"开始沟通"收集回复的候选人简历。';
      } else {
        if (startBtn) startBtn.style.display = 'none';
        if (startChatBtn) startChatBtn.style.display = 'none';
        if (tipEl) tipEl.textContent = '请在BOSS直聘的推荐候选人或消息页面使用此脚本。';
      }
    }

    saveConfig() {
      const cityEl = document.getElementById("hengyu-city");
      const greetLimitEl = document.getElementById("hengyu-greet-limit");
      const requirementsEl = document.getElementById("hengyu-requirements");
      const orderTypeEl = document.querySelector('input[name="hengyu-order-type"]:checked');
      const hospitalEl = document.querySelector('input[name="hengyu-hospital"]:checked');
      const timeRangeEl = document.querySelector('input[name="hengyu-time-range"]:checked');

      if (cityEl) state.config.targetCity = cityEl.value.trim();
      if (greetLimitEl) {
        const limitVal = parseInt(greetLimitEl.value, 10);
        state.config.greetLimit = isNaN(limitVal) || limitVal <= 0 ? 30 : limitVal;
      }
      if (requirementsEl) state.config.escortRequirements = requirementsEl.value;
      if (orderTypeEl) state.config.orderType = orderTypeEl.value;
      if (hospitalEl) state.config.hospitalRequired = hospitalEl.value;
      if (timeRangeEl) state.config.timeRange = timeRangeEl.value;
      Storage.set(CONFIG.STORAGE_KEYS.SETTINGS, state.config);
    }

    loadState() {
      const saved = Storage.get(CONFIG.STORAGE_KEYS.SETTINGS);
      if (saved) {
        Object.assign(state.config, saved);
        const cityEl = document.getElementById("hengyu-city");
        const greetLimitEl = document.getElementById("hengyu-greet-limit");
        const requirementsEl = document.getElementById("hengyu-requirements");

        if (cityEl) cityEl.value = state.config.targetCity || "";
        if (greetLimitEl && state.config.greetLimit) {
          greetLimitEl.value = state.config.greetLimit;
        }
        if (requirementsEl) requirementsEl.value = state.config.escortRequirements || "";

        // Restore radio buttons
        const orderVal = state.config.orderType || "普通单";
        const hospVal = state.config.hospitalRequired || "否";
        const orderEl = document.getElementById(orderVal === "急单" ? "hengyu-order-urgent" : "hengyu-order-normal");
        const hospEl = document.getElementById(hospVal === "是" ? "hengyu-hospital-yes" : "hengyu-hospital-no");
        if (orderEl) orderEl.checked = true;
        if (hospEl) hospEl.checked = true;

        // Restore time range radio button
        const timeRangeVal = state.config.timeRange || "全部";
        const timeRangeIdMap = {
          "全部": "hengyu-time-all",
          "今日": "hengyu-time-today",
          "近3日": "hengyu-time-3d",
          "近1周": "hengyu-time-1w",
          "近2周": "hengyu-time-2w"
        };
        const timeRangeEl = document.getElementById(timeRangeIdMap[timeRangeVal] || "hengyu-time-all");
        if (timeRangeEl) timeRangeEl.checked = true;
      }
      const candidates = Storage.getJSON(CONFIG.STORAGE_KEYS.CANDIDATES, []);
      const processed = Storage.getJSON(CONFIG.STORAGE_KEYS.PROCESSED, []);
      state.candidates = candidates;
      state.processedCandidateIds = new Set(processed);
      this.updateCount(candidates.length, candidates.filter(c => c.greeted).length, processed.length);
    }

    startCollect() {
      if (!state.config.targetCity) {
        this.log("Please enter target city first", "error");
        return;
      }
      this.saveConfig();
      state.isRunning = true;
      this.showStopButton();
      this.log("Starting candidate collection (Recommend page)...", "info");
      this.runRecommendPage();
    }

    async startChat() {
      state.isRunning = true;
      this.showStopButton();
      this.log("Starting chat automation (Messages page)...", "info");
      await this.runChatPage();
    }

    stop() {
      state.isRunning = false;
      this.hideStopButton();
      this.hideProgress();
      this.log("Stopped", "info");
    }

    showStopButton() {
      const startBtn = document.getElementById("hengyu-start");
      const startChatBtn = document.getElementById("hengyu-start-chat");
      const stopBtn = document.getElementById("hengyu-stop");
      const exportBtn = document.getElementById("hengyu-export");
      if (startBtn) startBtn.style.display = "none";
      if (startChatBtn) startChatBtn.style.display = "none";
      if (stopBtn) stopBtn.style.display = "block";
      if (exportBtn) exportBtn.disabled = true;
    }

    hideStopButton() {
      const startBtn = document.getElementById("hengyu-start");
      const startChatBtn = document.getElementById("hengyu-start-chat");
      const stopBtn = document.getElementById("hengyu-stop");
      const exportBtn = document.getElementById("hengyu-export");

      if (startBtn) startBtn.style.display = state.pageType === 'recommend' ? 'flex' : 'none';
      if (startChatBtn) startChatBtn.style.display = state.pageType === 'chat' ? 'flex' : 'none';
      if (stopBtn) stopBtn.style.display = "none";
      if (exportBtn) exportBtn.disabled = false;
    }

    // 推荐牛人页面主逻辑
    async runRecommendPage() {
      if (!state.isRunning) return;
      if (PageDetector.detect() !== 'recommend') {
        this.log("Please ensure you are on the Recommend page", "error");
        this.stop();
        return;
      }

      try {
        // 1. 选择岗位（按城市）
        this.log(`Selecting escort job for ${state.config.targetCity}...`, "info");
        const selected = await RecommendPage.selectJobByCity(state.config.targetCity);
        if (!selected) {
          this.log("Job selection failed, trying to continue...", "warn");
        }
        await Utils.sleep(Utils.randomDelay(1000));

        // 2. 筛选离职人员
        this.log("Filtering unemployed candidates...", "info");
        await RecommendPage.filterByUnemployed();
        await Utils.sleep(Utils.randomDelay(1000));

        // 3. 先滚动加载一些初始候选人
        this.log("Loading candidate list...", "info");
        for (let i = 0; i < 5; i++) {
          await RecommendPage.scrollToLoadMore();
          await Utils.sleep(300);
        }

        const greetLimit = state.config.greetLimit || 30;
        this.log(`Greet limit set to ${greetLimit}`, "info");

        // 4. 获取初始候选人列表并打招呼
        let { items } = RecommendPage.getCandidateCards();
        this.log(`Found ${items.length} candidates in current list`, "info");

        let greetedCount = 0;
        let currentIndex = 0;
        let consecutiveNoChange = 0; // 连续滚动后数量没变化次数

        while (state.isRunning && greetedCount < greetLimit) {
          // Update progress
          this.updateProgress(greetedCount, greetLimit, "Greeted");

          // 重新获取最新列表
          ({ items } = RecommendPage.getCandidateCards());

          // 尝试找到下一个未打招呼的候选人
          let found = false;
          for (let i = currentIndex; i < items.length && greetedCount < greetLimit; i++) {
            const card = items[i];
            const info = RecommendPage.extractCandidateInfo(card);
            if (!info) {
              currentIndex = i + 1;
              continue;
            }

            // 检查是否已打招呼
            if (state.processedCandidateIds.has(info.id)) {
              currentIndex = i + 1;
              continue;
            }

            // 记录候选人
            if (!state.candidates.find(c => c.id === info.id)) {
              state.candidates.push({
                id: info.id,
                name: info.name,
                currentJob: info.currentJob,
                status: info.status,
                city: state.config.targetCity,
                greeted: false,
                hasNurseCert: null,
                hasResume: false,
                collectedAt: Utils.formatDate(),
                replied: false
              });
            }

            // 打招呼
            const greeted = await RecommendPage.greetCandidate(card);
            if (greeted) {
              greetedCount++;
              state.processedCandidateIds.add(info.id);
              const candidate = state.candidates.find(c => c.id === info.id);
              if (candidate) candidate.greeted = true;
              this.log(`Greeted: ${info.name} (${greetedCount}/${greetLimit})`, "success");
              this.updateProgress(greetedCount, greetLimit, "Greeted");
            }

            currentIndex = i + 1;
            found = true;
            consecutiveNoChange = 0;
            await Utils.sleep(Utils.randomDelay(CONFIG.INTERVAL));
          }

          // 如果打招呼达到上限，退出
          if (greetedCount >= greetLimit) {
            this.log(`Reached greet limit of ${greetLimit}, stopping`, "success");
            break;
          }

          // 如果本轮没找到未打招呼的候选人，尝试滚动加载更多
          const beforeCount = items.length;
          await RecommendPage.scrollToLoadMore();
          await Utils.sleep(1500);
          const afterCount = RecommendPage.getCandidateCards().items.length;

          if (afterCount > beforeCount) {
            consecutiveNoChange = 0;
            this.log(`Loaded ${afterCount} candidates, continuing...`, "info");
          } else {
            consecutiveNoChange++;
            if (consecutiveNoChange >= 3) {
              this.log("Candidate list fully loaded", "warn");
              break;
            }
          }
        }

        // 保存状态
        Storage.set(CONFIG.STORAGE_KEYS.CANDIDATES, state.candidates);
        Storage.set(CONFIG.STORAGE_KEYS.PROCESSED, Array.from(state.processedCandidateIds));
        this.updateCount(
          state.candidates.length,
          state.candidates.filter(c => c.greeted).length,
          state.processedCandidateIds.size
        );

        this.log(`Collection complete. Total greeted: ${greetedCount}`, "success");
        this.stop();
      } catch (e) {
        this.log(`Collection error: ${e.message}`, "error");
        this.stop();
      }
    }

    // 沟通页面主逻辑
    async runChatPage() {
      if (!state.isRunning) return;
      if (PageDetector.detect() !== 'chat') {
        this.log("Please ensure you are on the Messages page", "error");
        this.stop();
        return;
      }

      try {
        const { items } = ChatPage.getChatList();
        this.log(`Found ${items.length} candidate conversations`, "info");

        for (let i = 0; i < items.length && state.isRunning; i++) {
          const item = items[i];
          const info = ChatPage.extractCandidateInfo(item);
          if (!info || !info.id) continue;

          // 过滤：只处理陪诊相关候选人，跳过其他岗位
          if (!ChatPage.isAccompanimentRelated(info)) {
            this.log(`Skipping non-escort: ${info.name} (${info.currentJob})`, "info");
            continue;
          }

          // 过滤：目标城市 — 职位字段需包含目标城市
          if (state.config.targetCity && !info.currentJob.includes(state.config.targetCity)) {
            this.log(`Skipping other city: ${info.name} (${info.currentJob})`, "info");
            continue;
          }

          // 过滤：时间范围 — 超出范围的跳过
          if (!Utils.isWithinTimeRange(info.lastActiveTime, state.config.timeRange)) {
            this.log(`Skipping old conversation: ${info.name} (${info.lastActiveTime})`, "info");
            continue;
          }

          // 点击进入聊天详情
          this.log(`Monitoring: ${info.name}`, "info");
          await ChatPage.openChat(item);
          await Utils.sleep(Utils.randomDelay(2000));

          const enterTime = Date.now();
          const MONITOR_TIMEOUT = 5 * 60 * 1000;
          let lastBadgeState = false;

          while (state.isRunning && (Date.now() - enterTime) < MONITOR_TIMEOUT) {
            const hasBadge = MessageMonitor.hasUnreadBadge();

            if (hasBadge && !lastBadgeState) {
              lastBadgeState = true;
              this.log(`[${info.name}] 检测到新消息`, "info");

              const hrMessage = MessageMonitor.getLatestHRMessage();
              this.log(`[${info.name}] HR消息: ${hrMessage.substring(0, 80)}`, "info");

              const TARGET_HR_MSG = "你好，在考虑新的工作机会吗？我是Boss的人事，有没有兴趣加入我们的团队呢?";
              if (hrMessage.includes(TARGET_HR_MSG) || TARGET_HR_MSG.includes(hrMessage)) {
                this.log(`[${info.name}] 匹配到目标HR消息，发送陪诊要求 + 询问兼职`, "info");
                await ChatPage.sendMessage(state.config.escortRequirements);
                await Utils.sleep(Utils.randomDelay(1000));
                await ChatPage.sendMessage("你好，请问方便兼职么？");
              }

              await Utils.sleep(Utils.randomDelay(3000));

              const candidateReply = MessageMonitor.getLatestCandidateMessage();
              if (candidateReply) {
                this.log(`[${info.name}] 候选人回复: ${candidateReply.substring(0, 80)}`, "info");

                try {
                  const aiReply = await DifyAgent.getChatReply(candidateReply, state.config.escortRequirements, state.config.orderType, state.config.hospitalRequired);
                  // 从回复中提取末尾的 true/false/continue 标签（大小写不敏感），去除标签后得到正文
                  const tagMatch = aiReply.match(/\s*(true|false|continue)\s*$/i);
                  const tag = tagMatch ? tagMatch[1].toLowerCase() : null;
                  const replyText = tagMatch ? aiReply.slice(0, tagMatch.index).trim() : aiReply;

                  if (!replyText) {
                    this.log(`[${info.name}] AI返回空，跳过发送`, "warn");
                    continue;
                  }

                  this.log(`[${info.name}] AI回复: ${replyText.substring(0, 80)}...`, "info");
                  await ChatPage.sendMessage(replyText);
                  await Utils.sleep(Utils.randomDelay(2000));

                  // false = 候选人不符合要求，跳过
                  if (tag === 'false') {
                    this.log(`[${info.name}] AI标记候选人不合格，跳过`, "warn");
                    break;
                  }

                  // true = 候选人符合要求，收藏 + 求简历
                  if (tag === 'true') {
                    this.log(`[${info.name}] AI标记候选人合格，收藏 + 求简历`, "success");
                    await ChatPage.favoriteCandidate();
                    await ChatPage.clickRequestResume();
                    break;
                  }

                  // continue 或无标签：对话继续，监听候选人下一条回复
                } catch (e) {
                  this.log(`[${info.name}] AI处理出错: ${e.message}`, "error");
                }
              }
            } else if (!hasBadge) {
              lastBadgeState = false;
            }

            await Utils.sleep(3000);
          }

          this.log(`[${info.name}] 监测结束，返回列表`, "warn");
          state.processedCandidateIds.add(info.id);
          await ChatPage.backToList();
          await Utils.sleep(Utils.randomDelay(1000));
        }

        Storage.set(CONFIG.STORAGE_KEYS.CANDIDATES, state.candidates);
        Storage.set(CONFIG.STORAGE_KEYS.PROCESSED, Array.from(state.processedCandidateIds));
        this.updateCount(
          state.candidates.length,
          state.candidates.filter(c => c.greeted).length,
          state.processedCandidateIds.size
        );

        this.log("Chat complete.", "success");
        this.stop();
      } catch (e) {
        this.log(`Chat error: ${e.message}`, "error");
        this.stop();
      }
    }

    exportData() {
      const candidates = Storage.getJSON(CONFIG.STORAGE_KEYS.CANDIDATES, []);
      if (!candidates.length) {
        this.log("No candidate data to export", "error");
        return;
      }

      // 筛选已沟通的候选人
      const qualified = candidates.filter(c =>
        c.hasNurseCert === true || c.hasNurseCert === null // 护士证未知也算
      );

      const header = "No.\tName\tCurrent Job\tCity\tHas Certificate\tHas Resume\tCollected At\tStatus\n";
      const rows = qualified.map((c, i) =>
        `${i + 1}\t${c.name || "Unknown"}\t${c.currentJob || ""}\t${c.city || ""}\t${c.hasNurseCert === true ? "Yes" : c.hasNurseCert === false ? "No" : "Unknown"}\t${c.hasResume ? "Yes" : "No"}\t${c.collectedAt || ""}\t${c.processedAt ? "Processed" : "Pending"}`
      ).join("\n");
      const tsv = header + rows;
      GM_setClipboard(tsv);
      this.log(`Copied ${qualified.length} records to clipboard. Paste into Excel.`, "success");
    }
  }

  // ==================== 轮询机制 ====================
  class PollingManager {
    static async startPolling() {
      if (state.isPolling) return;
      state.isPolling = true;
      ui.log("Starting polling mode, checking for new replies every 30 min...", "info");

      while (state.isPolling) {
        await Utils.sleep(CONFIG.POLL_INTERVAL);

        if (!state.isPolling) break;

        const lastPoll = Storage.get(CONFIG.STORAGE_KEYS.LAST_POLL);
        Storage.set(CONFIG.STORAGE_KEYS.LAST_POLL, new Date().toISOString());
        ui.log(`[Polling] ${new Date().toLocaleString()} Checking for new replies...`, "info");

        // 触发沟通页面逻辑
        if (PageDetector.detect() === 'chat') {
          await ui.runChatPage();
        }
      }
    }

    static stopPolling() {
      state.isPolling = false;
      ui.log("Polling stopped", "info");
    }
  }

  // ==================== 初始化 ====================
  const ui = new UI();

  // 页面加载后延迟渲染
  if (document.readyState === 'complete') {
    setTimeout(() => {
      ui.render();
      ui.log("Hengyu Recruit Assistant ready", "info");
      // 延迟更新页面指示器，等 iframe 内容加载完成
      setTimeout(() => ui.updatePageIndicator(), 2000);
    }, 1000);
  } else {
    window.addEventListener('load', () => {
      setTimeout(() => {
        ui.render();
        ui.log("Hengyu Recruit Assistant ready", "info");
        setTimeout(() => ui.updatePageIndicator(), 2000);
      }, 1000);
    });
  }

  // 监听URL变化（单页应用）
  let lastUrl = location.href;
  let lastFrameUrl = '';
  try {
    const f = TargetDoc.getFrame();
    lastFrameUrl = f ? f.location.href : '';
  } catch (e) {}
  new MutationObserver(() => {
    try {
      const currentUrl = location.href;
      let currentFrameUrl = '';
      try {
        const f = TargetDoc.getFrame();
        currentFrameUrl = f ? f.location.href : '';
      } catch (e) {}
      if (currentUrl !== lastUrl || currentFrameUrl !== lastFrameUrl) {
        lastUrl = currentUrl;
        lastFrameUrl = currentFrameUrl;
        setTimeout(() => {
          ui.updatePageIndicator();
          ui.log(`Page changed: ${currentFrameUrl || currentUrl}`, "info");
        }, 1000);
      }
    } catch (e) {}
  }).observe(document, { subtree: true, childList: true });

})();
