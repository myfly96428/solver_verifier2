class DualAIChat {
    constructor() {
        this.socket = io();
        this.isDebating = false;
        this.isPaused = false;
        this.isResuming = false; // 新增状态
        this.streamingMessages = new Map();
        this.initializeElements();
        this.bindEvents();
        this.setupSocketListeners();
    }

    initializeElements() {
        this.questionInput = document.getElementById('question-input');
        this.sendBtn = document.getElementById('send-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.forceEndBtn = document.getElementById('force-end-btn');
        this.clearBtn = document.getElementById('clear-btn');
        this.resumeBtn = document.getElementById('resume-btn');
        this.chatMessages = document.getElementById('chat-messages');
        this.status = document.getElementById('status');
        this.solutionContent = document.getElementById('solution-content');
        this.solutionVersion = document.getElementById('solution-version');
        this.finalAnswer = document.getElementById('final-answer');
        this.finalContent = document.getElementById('final-content');
        this.cognitoModel = document.getElementById('cognito-model');
        this.museModel = document.getElementById('muse-model');
        this.apiKey = document.getElementById('api-key');
        this.baseUrl = document.getElementById('base-url');
    }

    bindEvents() {
        this.sendBtn.addEventListener('click', () => this.startDebate());
        this.stopBtn.addEventListener('click', () => this.stopDebate());
        this.forceEndBtn.addEventListener('click', () => this.forceEndDebate());
        this.clearBtn.addEventListener('click', () => this.clearChat());
        this.resumeBtn.addEventListener('click', () => this.resumeDebate());
        
        this.questionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!this.isDebating) {
                    this.startDebate();
                }
            }
        });

        // 配置面板折叠功能
        const configToggle = document.getElementById('config-toggle');
        const configContent = document.getElementById('config-content');
        const configPanel = document.querySelector('.config-panel');
        const mainContent = document.querySelector('.main-content');
        
        configToggle.addEventListener('click', () => {
            const isCollapsed = configContent.classList.contains('collapsed');
            
            if (isCollapsed) {
                configContent.classList.remove('collapsed');
                configPanel.classList.remove('collapsed');
                mainContent.classList.remove('config-collapsed');
                configToggle.textContent = '−';
                configToggle.setAttribute('aria-label', '折叠配置');
            } else {
                configContent.classList.add('collapsed');
                configPanel.classList.add('collapsed');
                mainContent.classList.add('config-collapsed');
                configToggle.textContent = '+';
                configToggle.setAttribute('aria-label', '展开配置');
            }
            
            // 保存折叠状态
            localStorage.setItem('configCollapsed', !isCollapsed);
        });

        // 恢复折叠状态
        const savedCollapsed = localStorage.getItem('configCollapsed') === 'true';
        if (savedCollapsed) {
            configContent.classList.add('collapsed');
            configPanel.classList.add('collapsed');
            mainContent.classList.add('config-collapsed');
            configToggle.textContent = '+';
            configToggle.setAttribute('aria-label', '展开配置');
        }

        // 加载保存的配置
        this.loadConfig();
    }

    setupSocketListeners() {
        this.socket.on('debate-started', (data) => {
            this.onDebateStarted(data);
        });

        this.socket.on('message', (data) => {
            this.addMessage(data);
        });

        this.socket.on('stream-update', (data) => {
            this.handleStreamUpdate(data);
        });

        this.socket.on('stream-complete', (data) => {
            this.completeStreamingMessage(data);
        });

        this.socket.on('status-update', (data) => {
            this.updateStatus(data.status);
        });

        this.socket.on('solution-update', (data) => {
            this.updateSolution(data);
        });

        this.socket.on('solution-stream-start', (data) => {
            this.startSolutionStream(data);
        });

        this.socket.on('final-answer-start', (data) => {
            this.startFinalAnswerStream(data);
        });

        this.socket.on('final-answer', (data) => {
            this.showFinalAnswer(data);
        });

        this.socket.on('error', (data) => {
            this.showError(data.message);
        });

        this.socket.on('debate-paused', (data) => {
            this.onDebatePaused(data);
        });

        this.socket.on('resume-result', (data) => {
            this.onDebateResumeResult(data);
        });
        this.socket.on('remove-message', (data) => {
            this.removeMessage(data);
        });
        this.socket.on('state-rolled-back', (data) => {
            this.onStateRolledBack(data);
        });
    }

    startDebate() {
        const question = this.questionInput.value.trim();
        if (!question) {
            alert('请输入问题');
            return;
        }

        const apiKey = this.apiKey.value.trim();
        if (!apiKey) {
            alert('请输入API Key\n\n安全提示：\n- 您的API Key仅在本地使用，不会上传到服务器\n- 请确保API Key来源可靠\n- 建议定期更换API Key');
            return;
        }

        const baseURL = this.baseUrl.value.trim();
        if (!baseURL) {
            alert('请输入API Base URL\n\n常用地址：\n- OpenAI官方: https://api.openai.com/v1\n- 其他代理服务请确认地址正确');
            return;
        }

        // 验证API Key格式（基本检查）
        if (!apiKey.startsWith('sk-') && !apiKey.startsWith('gsk_')) {
            if (!confirm('API Key格式可能不正确，是否继续？\n\n常见格式：\n- OpenAI: sk-...\n- Google: gsk_...')) {
                return;
            }
        }

        const apiConfig = {
            apiKey: apiKey,
            baseURL: baseURL
        };

        this.saveConfig();
        this.clearChat();
        this.isDebating = true;
        this.updateButtonStates();

        this.socket.emit('start-debate', {
            question: question,
            cognitoModel: this.cognitoModel.value,
            museModel: this.museModel.value,
            apiConfig: apiConfig
        });
    }

    stopDebate() {
        this.socket.emit('stop-debate');
        this.isDebating = false;
        // 注意：不在这里设置 isPaused，等待服务器的 debate-paused 事件
        this.updateButtonStates();
    }

    forceEndDebate() {
        this.socket.emit('force-end-debate');
        this.isDebating = false;
        this.updateButtonStates();
        this.updateStatus('正在强制结束辩论...');
    }

    resumeDebate() {
        if (this.isResuming) return; // 防止重复点击

        this.isResuming = true;
        this.updateButtonStates();
        this.updateStatus('正在恢复辩论...');
        this.socket.emit('resume-debate');
    }

    clearChat() {
        // 如果正在辩论，先停止
        if (this.isDebating) {
            this.socket.emit('stop-debate');
            this.isDebating = false;
        }
        
        // 重置后端状态
        this.socket.emit('reset-debate');
        
        // 清除前端显示
        this.chatMessages.innerHTML = '';
        this.solutionContent.textContent = '等待生成初始方案...';
        this.solutionVersion.textContent = 'v1.0';
        this.finalAnswer.style.display = 'none';
        this.isPaused = false;
        this.updateStatus('准备就绪');
        this.updateButtonStates();
    }

    onDebateStarted(data) {
        this.addSystemMessage(`🚀 开始辩论: ${data.question}`);
    }

    addMessage(data) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${data.speaker.toLowerCase()}`;
        messageDiv.setAttribute('data-message-id', data.messageId || '');
        
        const speakerIcon = data.speaker === 'Cognito' ? '🧠' : '🎭';
        const typeText = this.getTypeText(data.type);
        
        const streamingIndicator = data.streaming ? '<span class="streaming-indicator">●</span>' : '';
        
        messageDiv.innerHTML = `
            <div class="message-header">
                <span class="speaker">${speakerIcon} ${data.speaker}</span>
                <span class="round-info">第${data.cycle}周期 第${data.round}轮 ${typeText} ${streamingIndicator}</span>
            </div>
            <div class="message-content">${this.formatContent(data.content)}</div>
        `;

        this.chatMessages.appendChild(messageDiv);

        if (data.streaming) {
            const contentDiv = messageDiv.querySelector('.message-content');
            if (contentDiv) {
                this.streamingMessages.set(data.messageId, contentDiv);
            }
        }

        this.scrollToBottom();
    }

    handleStreamUpdate(data) {
        // 根据新需求，此函数在流式更新期间不执行任何DOM操作。
        // 所有内容将在'stream-complete'事件中一次性渲染。
    }

    completeStreamingMessage(data) {
        const messageDiv = this.chatMessages.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageDiv) {
            const streamingIndicator = messageDiv.querySelector('.streaming-indicator');
            if (streamingIndicator) {
                streamingIndicator.remove();
            }
            const contentDiv = messageDiv.querySelector('.message-content');
            if (contentDiv) {
                contentDiv.innerHTML = this.formatContent(data.finalContent);
            }
            this.streamingMessages.delete(data.messageId);
            this.scrollToBottom();
        }
    }

    addSystemMessage(content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message system';
        messageDiv.innerHTML = `
            <div class="message-content" style="text-align: center; font-style: italic; color: #666;">
                ${content}
            </div>
        `;
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    updateStatus(status) {
        this.status.textContent = status;
        
        // 如果辩论完成，更新按钮状态
        if (status === '辩论完成' || status === '辩论已停止') {
            this.isDebating = false;
            this.updateButtonStates();
        }
    }

    updateSolution(data) {
        this.solutionContent.classList.add('updating');
        setTimeout(() => {
            this.solutionVersion.textContent = `v${data.version}`;
            this.solutionContent.textContent = data.content;
            this.solutionContent.classList.remove('updating', 'streaming');
        }, 300);
    }

    startSolutionStream(data) {
        this.solutionVersion.textContent = `v${data.version}`;
        this.solutionContent.textContent = '';
        this.solutionContent.classList.add('streaming');
    }

    showFinalAnswer(data) {
        this.finalContent.textContent = data.content;
        this.finalAnswer.style.display = 'block';
        this.finalAnswer.scrollIntoView({ behavior: 'smooth' });
        this.finalContent.classList.remove('streaming');
    }

    startFinalAnswerStream(data) {
        this.finalContent.textContent = '';
        this.finalAnswer.style.display = 'block';
        this.finalContent.classList.add('streaming');
        this.finalAnswer.scrollIntoView({ behavior: 'smooth' });
    }

    showError(message) {
        alert(`错误: ${message}`);
        this.isDebating = false;
        this.updateButtonStates();
    }

    onDebatePaused(data) {
        this.isDebating = false;
        this.isPaused = true;
        this.updateButtonStates();
        
        // 显示暂停信息
        this.addSystemMessage(`⏸️ 辩论已暂停: ${data.reason}`);
        this.addSystemMessage(`📊 重试次数: ${data.retryCount}, 错误: ${data.error}`);
        if (data.canResume) {
            this.addSystemMessage(`🔄 可以点击"恢复辩论"按钮手动重试`);
        }
    }

    onDebateResumeResult(data) {
        this.isResuming = false; // 无论成功失败，恢复流程结束

        if (data.success) {
            console.log('辩论恢复成功');
            this.isDebating = true;
            this.isPaused = false;
            this.updateButtonStates();
            // 状态由 'status-update' 事件驱动，这里只更新按钮
        } else {
            console.error('辩论恢复失败:', data.error);
            this.isDebating = false;
            this.isPaused = true; // 保持暂停状态
            this.showError(`恢复失败: ${data.error}`);
            this.updateStatus('恢复失败，请重试');
        }
        this.updateButtonStates();
    }
 
    onStateRolledBack(data) {
        console.log('接收到状态回滚事件', data);
        this.addSystemMessage('🔄 检测到状态回滚，正在恢复UI...');
 
        // 1. 清空消息区域
        this.chatMessages.innerHTML = '';
        this.streamingMessages.clear(); // 清除所有缓存的节点
 
        // 2. 重新渲染历史记录
        if (data.debateHistory && Array.isArray(data.debateHistory)) {
            data.debateHistory.forEach(messageData => {
                this.addMessage({ ...messageData, streaming: false }); // 确保旧消息不是流式
            });
        }
 
        // 3. 恢复方案区域
        if (data.solution) {
            this.updateSolution(data.solution);
        }
 
        // 4. 清理可能存在的流式消息
        const streamingIndicators = this.chatMessages.querySelectorAll('.streaming-indicator');
        streamingIndicators.forEach(el => el.remove());
 
        this.addSystemMessage('✅ UI已恢复至上一稳定状态');
    }
 
     updateButtonStates() {
         const isBusy = this.isDebating || this.isResuming;
         this.sendBtn.disabled = isBusy || this.isPaused;
        this.stopBtn.disabled = !this.isDebating;
        this.forceEndBtn.disabled = !this.isDebating;
        this.resumeBtn.disabled = !this.isPaused || isBusy;
        this.clearBtn.disabled = isBusy;
        this.questionInput.disabled = isBusy || this.isPaused;
    }

    removeMessage(data) {
        const messageDiv = this.chatMessages.querySelector(`[data-message-id="${data.messageId}"]`);
        if (messageDiv) {
            messageDiv.remove();
            this.streamingMessages.delete(data.messageId);
        }
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }


    getTypeText(type) {
        const typeMap = {
            'initial-solution': '初始方案',
            'first-critique': '首次批判',
            'response': '回应深化',
            'final-critique': '总结批判'
        };
        return typeMap[type] || '';
    }

    formatContent(content) {
        // 简单的格式化处理
        return content
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>');
    }

    saveConfig() {
        const config = {
            cognitoModel: this.cognitoModel.value,
            museModel: this.museModel.value,
            apiKey: this.apiKey.value,
            baseUrl: this.baseUrl.value
        };
        localStorage.setItem('dualAIConfig', JSON.stringify(config));
    }

    loadConfig() {
        const saved = localStorage.getItem('dualAIConfig');
        if (saved) {
            const config = JSON.parse(saved);
            this.cognitoModel.value = config.cognitoModel || 'gemini-2.5-pro';
            this.museModel.value = config.museModel || 'gemini-2.5-pro';
            this.apiKey.value = config.apiKey || '';
            this.baseUrl.value = config.baseUrl || '';
        }
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new DualAIChat();
});