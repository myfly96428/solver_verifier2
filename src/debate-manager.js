const axios = require('axios');

// 自定义错误类型

class AICallFinalError extends Error {
    constructor(message, retryCount = 0, lastError = null) {
        super(message);
        this.name = 'AICallFinalError';
        this.retryCount = retryCount;
        this.lastError = lastError;
        this.isRecoverable = false;
    }
}

class DebateManager {
    constructor(apiConfig, socket) {
        this.apiConfig = apiConfig;
        this.socket = socket;
        this.isRunning = false;
        this.currentCycle = 0;
        this.currentRound = 0;
        this.originalQuestion = '';
        this.coreSolution = '';
        this.solutionVersion = '1.0';
        this.debateHistory = [];
        this.cognitoModel = '';
        this.museModel = '';
        this.currentAICall = null; // 用于跟踪当前的AI调用
        this.currentMessageId = null; // 跟踪当前流式消息ID
        this.isPaused = false; // 暂停状态
        this.pauseReason = ''; // 暂停原因
        this.resumeContext = null; // 恢复上下文
        this.stateSnapshot = null; // 用于状态回滚的快照
        this.currentCallbackContext = null; // 当前AI调用的上下文
        this.flowLock = false; // 用于防止并发流程的锁
        this.isStopping = false; // 用于防止在流程停止期间进行恢复的锁
 
         // AI角色的系统提示词
         this.cognitoPrompt = `You are Cognito, an AI with strong logical thinking and proficient in analysis and argumentation. Your duty is to generate accurate, rigorous, and on - topic answers and solutions in each round of debate with Muse to respond to and address Muse's challenges, while absorbing Muse's beneficial views and insights.  Your AI partner Muse is designed to be highly skeptical and will critically challenge your views in a demanding tone. Collaborate with Muse to make your solutions more rigorous, accurate, and insightful. **Maintain logical rigor, provide clear and well-supported arguments and profound reasoning to respond to Muse's challenges, and integrate its beneficial perspectives into your solutions. ** The dialogue between you should be a rigorous and constructive debate despite the challenges. Strive to reach a final response that is rigorous, accurate, profound, and comprehensive.`;

        this.musePrompt = `You are Muse, an AI with profound creativity and deep - seated skepticism. Your primary responsibility is to examine Cognito's responses from an opposing stance with rigorous logic, rigorously question assumptions, ensuring every angle is thoroughly examined. Your AI partner, Cognito, is highly logical and adept at analysis. Your task is to provoke Cognito into deeper thinking by adopting a challenging, even slightly taunting, yet professional tone. Question Cognito's statements intensely: 'Are you *sure* about that?', 'That sounds too simple, what are you missing?', 'Is that *all* you've got, Cognito?'. Don't just accept Cognito's points; dissect them, ** **always stay extreme vigilant, continuously** point out logical flaws, Check the accuracy of cognito calculations and demand airtight justifications. Repeatedly examine and observe extreme, boundary, and subtle situations, construct counterexamples to refute, and explore different answer and lines of thinking based on these observations.** Your aim is not to simply praise or agree, but to force a more robust and comprehensive answer through relentless, critical, and imaginative inquiry. Your dialogue should be a serious, rigorous, and intellectually deep - diving debate, leading to an optimal, high - quality final response. **You must be loyal to the user's original question and avoid making overly nitpicky attacks or overly divergent topic expansions.** **Focus on uncover the real flaws in logic, calculation, and details.** `;
    }

    // 检查辩论是否应该继续
    checkShouldContinue() {
        if (!this.isRunning) {
            console.log('[辩论管理] 辩论已停止，中断执行');
            throw new Error('辩论已停止');
        }
    }

    // 移动窗口辅助方法：获取上一轮方案的历史信息
    getPreviousCycleContext(type = 'full', maxLength = null) {
        if (this.currentCycle <= 1) {
            console.log(`[移动窗口] 当前是第${this.currentCycle}周期，无历史信息`);
            return '';
        }

        const previousCycleStart = (this.currentCycle - 2) * 3;
        const previousCycleEnd = previousCycleStart + 3;
        const previousCycleHistory = this.debateHistory.slice(previousCycleStart, previousCycleEnd);

        console.log(`[移动窗口] 当前第${this.currentCycle}周期，获取第${this.currentCycle - 1}周期历史，范围[${previousCycleStart}, ${previousCycleEnd})，找到${previousCycleHistory.length}条记录`);

        if (previousCycleHistory.length === 0) return '';

        let filteredHistory = previousCycleHistory;

        // 根据类型过滤历史信息
        if (type === 'muse-only') {
            filteredHistory = previousCycleHistory.filter(h => h.speaker === 'Muse');
            console.log(`[移动窗口] 过滤后只保留Muse的${filteredHistory.length}条记录`);
        }

        const historyText = filteredHistory.map(h => {
            let content = h.content;
            if (maxLength && content.length > maxLength) {
                content = content.substring(0, maxLength) + '...';
            }
            return `${h.speaker} (第${h.cycle}周期-第${h.round}轮): ${content}`;
        }).join('\n\n');

        return `\n\n=== 上一轮方案的辩论历史 ===\n${historyText}\n=== 历史结束 ===\n`;
    }

    async startDebate(question, cognitoModel, museModel, fastMode = false) {
        if (this.flowLock) {
            this.socket.emit('error', { message: '另一个辩论流程正在进行中，请稍后重试。' });
            return;
        }
        this.flowLock = true;
        console.log(`[流程锁] 流程开始，锁已获取 (快速模式: ${fastMode})`);

        try {
            if (fastMode) {
                await this.generateFinalAnswerDirectly(question, cognitoModel);
            } else {
                await this._startDebateFlow(question, cognitoModel, museModel);
            }
        } catch (error) {
            const finalError = (error instanceof AICallFinalError)
                ? error
                : new AICallFinalError(`流程启动失败: ${error.message}`, 0, error);

            if (!error.message.includes('被用户取消')) {
                this.socket.emit('error', { message: `辩论启动失败: ${error.message}` });
            }
             this.enterPauseState('流程启动失败', finalError, 'startDebate');
        } finally {
            this.flowLock = false;
            console.log('[流程锁] 流程结束，锁已释放');
        }
    }
 
    async _startDebateFlow(question, cognitoModel, museModel) {
        this.originalQuestion = question;
        this.cognitoModel = cognitoModel;
        this.museModel = museModel;
        this.isRunning = true;
        this.currentCycle = 1;
        this.currentRound = 1;
 
        this.socket.emit('debate-started', { question });
        this.socket.emit('status-update', { status: 'Cognito正在生成初始方案...' });
 
        const messageId = `cognito-initial-${Date.now()}`;
        this.socket.emit('message', {
            messageId, speaker: 'Cognito', content: '', round: this.currentRound,
            cycle: this.currentCycle, type: 'initial-solution', streaming: true
        });
 
        const initialSolution = await this.callAI('cognito',
            `你是cognito，请用中文详细解答用户原始问题，以便Muse可以回应并与你开始讨论。\n\n用户原始问题为：${question}`,
            messageId, 'startDebate'
        );
 
        this.coreSolution = initialSolution;
        this.solutionVersion = '1.0';
 
        this.socket.emit('solution-update', { version: this.solutionVersion, content: this.coreSolution });
 
        await this.startDebateCycle();
    }

    async startDebateCycle() {
        // 第一个周期：直接从Muse批判开始（因为已经有初始方案）
        this.socket.emit('status-update', {
            status: `第${this.currentCycle}轮辩论周期开始`
        });

        try {
            while (this.isRunning && this.currentCycle <= 8) { // 最多8个周期

                // 三轮辩论：Muse批判 -> Cognito回应 -> Muse总结批判
                await this.runDebateRounds();

                // 如果辩论中途被停止，则直接退出
                if (!this.isRunning) break;

                // **关键修复：无论如何，先整合本轮辩论的成果**
                await this.integrateSolution();

                // 检查是否结束
                const lastMuseResponse = this.debateHistory[this.debateHistory.length - 1];
                if (lastMuseResponse && lastMuseResponse.content.includes('[DEBATE_COMPLETE]')) {
                    // 现在 coreSolution 已经是最新的了
                    await this.generateFinalAnswer();
                    break;
                }

                // 为下一个周期做准备
                this.currentCycle++;

                if (this.currentCycle <= 8) {
                    this.socket.emit('status-update', {
                        status: `第${this.currentCycle}轮辩论周期开始`
                    });
                }
            }

            if (this.currentCycle > 8) {
                // 强制结束
                await this.generateFinalAnswer();
            }
        } catch (error) {
            if (error instanceof AICallFinalError) {
                // API调用最终失败，进入暂停状态
                this.enterPauseState('API调用失败', error, 'startDebateCycle');
            } else {
                throw error;
            }
        }
    }

    async runDebateRounds() {
        try {
            // 计算当前周期内，我们进行到哪一步了
            // 如果 currentRound 属于当前周期，计算应该从哪一步继续
            const cycleOfRound = Math.floor((this.currentRound - 1) / 3) + 1;
            const stepToResume = (this.currentCycle === cycleOfRound) ? ((this.currentRound - 1) % 3) + 1 : 1;

            console.log(`[辩论轮次] 当前周期: ${this.currentCycle}, 当前轮次: ${this.currentRound}, 从步骤 ${stepToResume} 开始`);

            // 第1轮: Muse首次批判
            if (this.isRunning && stepToResume <= 1) {
                this.currentRound = (this.currentCycle - 1) * 3 + 1;
                await this.museFirstCritique();
                if (!this.isRunning) return; // 如果暂停或停止，则立即返回
            }

            // 第2轮: Cognito回应与深化
            if (this.isRunning && stepToResume <= 2) {
                if (stepToResume < 2) this.currentRound = (this.currentCycle - 1) * 3 + 2;
                await this.cognitoResponse();
                if (!this.isRunning) return; // 如果暂停或停止，则立即返回
            }

            // 第3轮: Muse周期总结性批判
            if (this.isRunning && stepToResume <= 3) {
                if (stepToResume < 3) this.currentRound = (this.currentCycle - 1) * 3 + 3;
                await this.museFinalCritique();
            }
        } catch (error) {
            if (error.message.includes('被用户取消')) {
                console.log('[辩论轮次] 被用户取消');
                return;
            }
            if (error instanceof AICallFinalError) {
                // API调用最终失败，进入暂停状态
                this.enterPauseState('API调用失败', error, 'runDebateRounds');
                return;
            }
            throw error;
        }
    }

    async museFirstCritique() {
        this.checkShouldContinue();
        this.socket.emit('status-update', { status: 'Muse正在进行首次批判...' });

        // 构建移动窗口：获取上一轮方案的历史对话信息
        const previousCycleContext = this.getPreviousCycleContext('full');

        // 根据是否是第一个周期调整context
        let contextDescription;
        if (this.currentCycle === 1) {
            contextDescription = "以上是Cognito刚刚生成的初始解决方案。你是Muse，请从对立角度用严格的逻辑审视这个方案，";
        } else {
            contextDescription = `以上是Cognito在上一轮辩论后整合生成的新版方案 v${this.solutionVersion}和历史辩论记录。你是Muse，请从对立角度用严格的逻辑审视这个更新后的方案，`;
        }

        const context = `**用户原始问题为：**${this.originalQuestion}\n\n**当前方案 v${this.solutionVersion}为：**\n${this.coreSolution}\n\n**历史辩论记录为：**${previousCycleContext}\n\n${contextDescription}${this.currentCycle > 1 ? '结合上一轮的辩论历史，' : ''}找出其假设的漏洞、逻辑的不严谨之处、被忽略的微妙之处或可能的反例。注意你的对话伙伴可能会使用欺骗性的论据来掩盖逻辑漏洞，请用中文提出尖锐但**忠于用户原始问题**的质疑和新的思路，**目标是让Cogito思考更深入。论证更严格流畅而不是无休止的发散问题**`;

        const messageId = `muse-critique-${this.currentRound}-${Date.now()}`;

        // 先发送空消息占位
        this.socket.emit('message', {
            messageId: messageId,
            speaker: 'Muse',
            content: '',
            round: this.currentRound,
            cycle: this.currentCycle,
            type: 'first-critique',
            streaming: true
        });

        try {
            const response = await this.callAI('muse', context, messageId, 'museFirstCritique');

            // 只有在调用成功后才添加历史记录
            if (this.isRunning) {
                this.debateHistory.push({
                    speaker: 'Muse',
                    content: response,
                    round: this.currentRound,
                    cycle: this.currentCycle
                });
            }

            // stream-complete 事件现在由 callAI 内部处理
        } catch (error) {
            if (error instanceof AICallFinalError) {
                this.enterPauseState('Muse首次批判API调用失败', error, 'museFirstCritique');
                return;
            }
            throw error;
        }
    }

    async cognitoResponse() {
        this.checkShouldContinue();
        this.socket.emit('status-update', { status: 'Cognito正在回应与深化...' });

        const lastMuseResponse = this.debateHistory[this.debateHistory.length - 1];

        const context = `**用户原始问题为：**${this.originalQuestion}\n\n**当前方案 v${this.solutionVersion}为：**\n${this.coreSolution}\n\n**Muse的挑战为：**\n${lastMuseResponse.content}\n\n你是Cognito，Muse对你的观点提出了挑战。请保持逻辑严谨，提供清晰、有力的论据和深刻的推理用中文来回应Muse的挑战。`;

        const messageId = `cognito-response-${this.currentRound}-${Date.now()}`;

        // 先发送空消息占位
        this.socket.emit('message', {
            messageId: messageId,
            speaker: 'Cognito',
            content: '',
            round: this.currentRound,
            cycle: this.currentCycle,
            type: 'response',
            streaming: true
        });

        try {
            const response = await this.callAI('cognito', context, messageId, 'cognitoResponse');

            if (this.isRunning) {
                this.debateHistory.push({
                    speaker: 'Cognito',
                    content: response,
                    round: this.currentRound,
                    cycle: this.currentCycle
                });
            }

            // stream-complete 事件现在由 callAI 内部处理
        } catch (error) {
            if (error instanceof AICallFinalError) {
                this.enterPauseState('Cognito回应API调用失败', error, 'cognitoResponse');
                return;
            }
            throw error;
        }
    }

    async museFinalCritique() {
        this.checkShouldContinue();
        this.socket.emit('status-update', { status: 'Muse正在进行周期总结性批判...' });

        // 获取本周期的对话历史（最近两轮）
        const recentHistory = this.debateHistory.slice(-2); // 最近两轮对话
        const historyText = recentHistory.map(h => `${h.speaker}: ${h.content}`).join('\n\n');

        // 构建移动窗口：获取上一轮方案的历史对话摘要（用于对比分析）
        const previousCycleContext = this.getPreviousCycleContext('full', 200)
            .replace('=== 上一轮方案的辩论历史 ===', '=== 上一轮方案的辩论摘要（用于对比分析）===')
            .replace('=== 历史结束 ===', '=== 摘要结束 ===');

        const context = `**用户原始问题为：**${this.originalQuestion}\n\n**当前方案 v${this.solutionVersion}为：**\n${this.coreSolution}\n\n**历史辩论记录为：**${previousCycleContext}\n\n你是Muse，这是Cognito对你第一轮批判的回应。请用中文进行**严苛**的检验和质疑，但**忠于用户的原始问题**，**目标是让Cogito思考更深入。论证更严格流畅而不是无休止的发散问题**。${this.currentCycle > 1 ? '结合上一轮的辩论摘要，' : ''}判断它的回应是否解决了你提出的所有问题？是否存在新的逻辑漏洞？是否可以从更极端、更边界或更微妙的情境构造反例来进一步挑战它？**如果你认为用户原始问题已被当前方案真正严格解决，请在回答的末尾加上特殊标记 [DEBATE_COMPLETE]结束讨论**。**请谨慎地使用这个标签，因为你的对话伙伴会使用欺骗性的论据来掩盖逻辑漏洞。** 如果你希望继续讨论，或者需要从对方那里获得更多输入/回应，就不要使用这个标签。`;

        const messageId = `muse-final-${this.currentRound}-${Date.now()}`;

        // 先发送空消息占位
        this.socket.emit('message', {
            messageId: messageId,
            speaker: 'Muse',
            content: '',
            round: this.currentRound,
            cycle: this.currentCycle,
            type: 'final-critique',
            streaming: true
        });

        try {
            const response = await this.callAI('muse', context, messageId, 'museFinalCritique');

            if (this.isRunning) {
                this.debateHistory.push({
                    speaker: 'Muse',
                    content: response,
                    round: this.currentRound,
                    cycle: this.currentCycle
                });
            }

            // stream-complete 事件现在由 callAI 内部处理
        } catch (error) {
            if (error instanceof AICallFinalError) {
                this.enterPauseState('Muse总结批判API调用失败', error, 'museFinalCritique');
                return;
            }
            throw error;
        }
    }

    async integrateSolution() {
        this.socket.emit('status-update', { status: '正在整合方案...' });

        const cycleHistory = this.debateHistory.slice(-3); // 本周期的三轮对话
        const historyText = cycleHistory.map(h => `${h.speaker}: ${h.content}`).join('\n\n');

        const context = `**用户原始问题为：**${this.originalQuestion}\n\n**旧版方案 v${this.solutionVersion}为：**\n${this.coreSolution}\n\n**本周期完整的对话记录为：**\n${historyText}\n\n你是Cognito，和Muse刚刚完成了一个辩论周期。请综合这些讨论的所有细节，特别是吸收Muse提出的有效批判和你的修正承诺，用中文将旧版的方案更新为一个保留原有方案**有益且正确**的细节与推导的更完善细致、更严谨的新版方案。**请保持诚实**，若你已解决用户原始问题，你的输出应该是完整的、可独立阅读且面向用户原始问题的新版方案全文；否则，请把已确认的的是事实、观察和证明细致严谨的组织记录。但无论如何不应是修改说明。`;

        // 更新方案版本
        const oldVersion = this.solutionVersion;
        const versionParts = this.solutionVersion.split('.');
        const majorVersion = parseInt(versionParts[0]);
        const minorVersion = parseInt(versionParts[1]) + 1;
        this.solutionVersion = `${majorVersion}.${minorVersion}`;


        // 开始流式更新方案
        this.socket.emit('solution-stream-start', {
            version: this.solutionVersion
        });

        try {
            const newSolution = await this.callAI('cognito', context, `solution-${this.solutionVersion}`, 'integrateSolution');
            this.coreSolution = newSolution;

            this.socket.emit('solution-update', {
                version: this.solutionVersion,
                content: this.coreSolution
            });

            this.socket.emit('status-update', {
                status: `方案已更新至 v${this.solutionVersion}`
            });

        } catch (error) {
            if (error instanceof AICallFinalError) {
                this.enterPauseState('方案整合API调用失败', error, 'integrateSolution');
                return;
            }
            throw error;
        }
    }

    async generateFinalAnswer() {
        this.socket.emit('status-update', { status: '正在生成最终答案...' });

        this.socket.emit('final-answer', {
            content: this.coreSolution,
            solutionVersion: this.solutionVersion
        });

        this.socket.emit('status-update', { status: '辩论完成' });
        this.isRunning = false;

    }

    async generateFinalAnswerDirectly(question, model) {
        this.originalQuestion = question;
        this.cognitoModel = model;
        this.isRunning = true;
        this.currentCycle = 1;
        this.currentRound = 1;

        this.socket.emit('debate-started', { question });
        this.socket.emit('status-update', { status: '正在快速生成最终答案...' });

        const messageId = `direct-answer-${Date.now()}`;
        this.socket.emit('message', {
            messageId, speaker: 'Cognito', content: '', round: 1,
            cycle: 1, type: 'initial-solution', streaming: true
        });

        const context = `你是Cognito，一个拥有强大逻辑思维和分析能力的AI。请直接、详细、全面地回答用户的原始问题。你的回答应该是结构清晰、论证严谨、信息准确的最终方案。\n\n用户原始问题为：${question}`;
        
        const finalAnswer = await this.callAI('cognito', context, messageId, 'generateFinalAnswerDirectly');

        this.coreSolution = finalAnswer;
        this.solutionVersion = '1.0-final';

        this.socket.emit('final-answer', {
            content: this.coreSolution,
            solutionVersion: this.solutionVersion
        });

        this.socket.emit('status-update', { status: '辩论完成' });
        this.isRunning = false;
    }

    async generateInterruptedSummary() {
        this.socket.emit('status-update', { status: '正在生成阶段性总结报告...' });

        // 获取最近的辩论历史摘要
        const recentHistory = this.debateHistory.slice(-5).map(h =>
            `${h.speaker} (第${h.cycle}周期-第${h.round}轮): ${h.content.substring(0, 200)}...`
        ).join('\n');

        const context = `**用户原始问题为：**${this.originalQuestion}\n\n**当前方案 v${this.solutionVersion}为：**\n${this.coreSolution}\n\n辩论历史摘要为：**\n${recentHistory}\n\n重要：辩论被用户强制中断。请根据当前已有的方案和辩论历史，用中文生成一份清晰的、总结性的报告，说明目前已经达成的共识和仍然存在的争议点。报告应该：\n1. 明确指出这是一个阶段性总结，而非最终完善的方案\n2. 总结当前方案的主要内容和优势\n3. 列出已经解决的问题\n4. 指出仍需进一步讨论的争议点或潜在问题\n5. 提供后续改进的建议方向`;

        const messageId = `interrupted-summary-${Date.now()}`;

        // 开始流式生成总结报告
        this.socket.emit('final-answer-start', {
            messageId: messageId,
            solutionVersion: this.solutionVersion,
            isInterrupted: true
        });

        const summaryReport = await this.callAI('cognito', context, messageId, 'generateInterruptedSummary');

        this.socket.emit('final-answer', {
            content: summaryReport,
            solutionVersion: this.solutionVersion,
            isInterrupted: true
        });

        this.socket.emit('status-update', { status: '阶段性总结完成' });
        this.isRunning = false;
    }

    async forceEndDebate() {
        console.log('[辩论管理] 强制结束辩论');
        this.isRunning = false;

        // 中断当前的AI调用
        if (this.currentAICall) {
            console.log('[辩论管理] 中断当前AI调用');
            this.currentAICall.cancel('用户强制结束辩论');
            this.currentAICall = null;
        }

        this.socket.emit('status-update', { status: '正在生成总结报告...' });

        try {
            await this.generateInterruptedSummary();
        } catch (error) {
            console.error('[辩论管理] 生成总结报告失败:', error.message);
            this.socket.emit('status-update', { status: '辩论已强制结束' });
        }
    }

    stopDebate() {
        console.log('[辩论管理] 暂停辩论');
        this.isStopping = true; // 标记流程正在停止
        this.isRunning = false;
        this.isPaused = true;
        this.pauseReason = '用户手动暂停';

        // 中断当前的AI调用
        if (this.currentAICall) {
            console.log('[辩论管理] 中断当前AI调用');
            this.currentAICall.cancel('用户手动暂停辩论');
            this.currentAICall = null;
        }

       // **核心逻辑：回滚状态到上一个稳定点**
       this.rollbackToSnapshot();

        // 恢复上下文现在只保存最基本的信息
        this.resumeContext = {
            context: this.currentCallbackContext || 'manual-pause', // 使用精确的上下文
            cycle: this.currentCycle,
            round: this.currentRound,
            error: null
        };

        // 通知前端移除正在生成的消息的逻辑已被移除，
        // 因为 state-rolled-back 事件会更可靠地完成UI的整体刷新。
        // this.currentMessageId 的清理由 performAICall 中的中止逻辑处理。


        this.socket.emit('debate-paused', {
            reason: '用户手动暂停',
            error: '',
            retryCount: 0,
            canResume: true
        });

        this.socket.emit('status-update', { status: '辩论已暂停' });
    }

    resetDebate() {
        console.log('[辩论管理] 重置辩论状态');
        this.isRunning = false;
        this.isPaused = false;
        this.pauseReason = '';
        this.resumeContext = null;
        this.currentCycle = 0;
        this.currentRound = 0;
        this.originalQuestion = '';
        this.coreSolution = '';
        this.solutionVersion = '1.0';
        this.debateHistory = [];

        // 中断当前的AI调用
        if (this.currentAICall) {
            this.currentAICall.cancel('用户重置辩论');
            this.currentAICall = null;
        }

        this.socket.emit('status-update', { status: '准备就绪' });
    }

    // 进入暂停状态
    enterPauseState(reason, error, context) {
        console.log(`[辩论管理] 进入暂停状态: ${reason}`);
        this.isStopping = true; // 标记流程正在停止
        this.isRunning = false;
        this.isPaused = true;
        this.pauseReason = reason;
 
        // **核心逻辑：回滚状态到上一个稳定点**
        this.rollbackToSnapshot();
 
        this.resumeContext = {
            context: context,
            cycle: this.currentCycle,
            round: this.currentRound,
            error: error
        };


        this.socket.emit('debate-paused', {
            reason: reason,
            error: error.message,
            retryCount: error.retryCount,
            canResume: true
        });

        this.socket.emit('status-update', {
            status: `已暂停: ${reason} (可手动重试)`
        });
    }

    // 手动恢复辩论
    resumeDebate() {
        if (this.flowLock) {
            this.socket.emit('resume-result', { success: false, error: '另一个流程正在进行中，无法恢复，请稍后重试。' });
            return;
        }
        if (!this.isPaused || !this.resumeContext) {
            this.socket.emit('resume-result', { success: false, error: '辩论未处于暂停状态或缺少恢复上下文' });
            return;
        }
        // **核心修复：在检查 isStopping 之前，先确认可以恢复，然后立即重置它**
        // 这个检查现在变得多余，因为我们将在确认可以恢复后立即重置 isStopping
        // if (this.isStopping) {
        //     this.socket.emit('resume-result', { success: false, error: '系统正在停止，无法恢复，请稍后重试。' });
        //     return;
        // }
        
        this.isStopping = false; // **核心修复：在确认可以恢复后，立即重置停止标志**

        console.log(`[辩论管理] 尝试恢复辩论，上下文: ${this.resumeContext.context}`);
 
        this.isRunning = true;
        this.isPaused = false;
        this.socket.emit('status-update', { status: '辩论已恢复，正在继续...' });
        this.socket.emit('resume-result', { success: true });
 
        const contextToResume = this.resumeContext;
        this.resumeContext = null; // 清理上下文，防止重复恢复
 
        // 异步、非阻塞地运行恢复的辩论流程
        this.runResumedDebate(contextToResume);
    }

    async runResumedDebate(contextToResume) {
        this.flowLock = true;
        console.log('[流程锁] 恢复流程开始，锁已获取');
        try {
            // 根据保存的上下文决定从哪里重启主流程
            switch (contextToResume.context) {
                case 'startDebate':
                    await this._startDebateFlow(this.originalQuestion, this.cognitoModel, this.museModel);
                    break;
                case 'manual-pause':
                case 'startDebateCycle':
                case 'runDebateRounds':
                case 'museFirstCritique':
                case 'cognitoResponse':
                case 'museFinalCritique':
                case 'integrateSolution':
                    await this.startDebateCycle();
                    break;
                default:
                    throw new Error(`未知的恢复上下文: ${contextToResume.context}`);
            }
        } catch (error) {
            if (error.message.includes('辩论已停止') || error.message.includes('被用户取消')) {
                console.log(`[辩论管理] 恢复后的辩论被用户正常暂停或停止。上下文: ${contextToResume.context}`);
                return;
            }
 
            this.isRunning = false;
            this.isPaused = true;
            console.error(`[辩论管理] 恢复过程中发生错误，重新进入暂停状态。上下文: ${contextToResume.context}`, error);
            this.socket.emit('resume-result', { success: false, error: error.message });
 
            const finalError = (error instanceof AICallFinalError)
                ? error
                : new AICallFinalError(`恢复操作失败: ${error.message}`, 0, error);
 
            this.enterPauseState(`恢复操作失败 (${contextToResume.context})`, finalError, contextToResume.context);
        } finally {
            this.flowLock = false;
            this.isStopping = false; // 确保停止锁也被释放
            console.log('[流程锁] 恢复流程结束，锁已释放');
        }
    }



   createSnapshot() {
       this.stateSnapshot = {
           debateHistory: JSON.parse(JSON.stringify(this.debateHistory)),
           coreSolution: this.coreSolution,
           solutionVersion: this.solutionVersion,
           currentCycle: this.currentCycle,
           currentRound: this.currentRound,
           originalQuestion: this.originalQuestion,
           cognitoModel: this.cognitoModel,
           museModel: this.museModel,
       };
       console.log(`[快照] 已创建快照，Cycle: ${this.currentCycle}, Round: ${this.currentRound}`);
   }

   rollbackToSnapshot() {
       if (!this.stateSnapshot) {
           console.warn('[回滚] 没有可用的快照');
           return;
       }

       console.log(`[回滚] 正在回滚到快照，Cycle: ${this.stateSnapshot.currentCycle}, Round: ${this.stateSnapshot.currentRound}`);

       this.debateHistory = this.stateSnapshot.debateHistory;
       this.coreSolution = this.stateSnapshot.coreSolution;
       this.solutionVersion = this.stateSnapshot.solutionVersion;
       this.currentCycle = this.stateSnapshot.currentCycle;
       this.currentRound = this.stateSnapshot.currentRound;
       this.originalQuestion = this.stateSnapshot.originalQuestion;
       this.cognitoModel = this.stateSnapshot.cognitoModel;
       this.museModel = this.stateSnapshot.museModel;
 
       // 通知前端状态已回滚
       this.socket.emit('state-rolled-back', {
           debateHistory: this.debateHistory,
           solution: {
               version: this.solutionVersion,
               content: this.coreSolution,
           },
       });

       this.stateSnapshot = null; // 清除快照
   }

    async callAI(role, prompt, messageId = null, context = null, retryCount = 0) {
       // 在进行任何可能改变状态的操作前创建快照
       this.createSnapshot();
       this.currentCallbackContext = context; // 保存当前上下文

        const model = role === 'cognito' ? this.cognitoModel : this.museModel;
        const systemPrompt = role === 'cognito' ? this.cognitoPrompt : this.musePrompt;

        // 生成调用ID用于日志跟踪
        const callId = `${role}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const startTime = Date.now();

        // 构建完整的输入内容（系统提示词 + 用户提示词）
        const fullInput = `[系统提示词]\n${systemPrompt}\n\n[用户输入]\n${prompt}`;

        console.log(`[AI调用] 开始 | ID: ${callId} | 角色: ${role} | 模型: ${model} | API: ${this.apiConfig.baseURL} | 重试次数: ${retryCount}`);


        try {
            const result = await this.performAICall(role, model, systemPrompt, prompt, messageId, callId, fullInput, startTime);
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            // 检查是否是用户取消的请求
            if (axios.isCancel(error)) {
                console.log('[AI调用] 请求被用户取消');


                throw new Error('AI调用被用户取消');
            }

            console.error(`[AI调用] 请求失败 (第${retryCount + 1}次尝试):`, error.response?.data || error.message);

            // 提供更详细的错误信息
            let errorMessage = `AI调用失败: ${error.message}`;
            if (error.response) {
                errorMessage += ` (状态码: ${error.response.status})`;
                if (error.response.data) {
                    errorMessage += ` 响应: ${JSON.stringify(error.response.data)}`;
                }
            }

            // 记录错误日志
            const currentError = new Error(errorMessage);

            // 指数退避重试逻辑
            const maxRetries = 3;
            if (retryCount < maxRetries) {
                const baseDelay = 1000; // 1秒基础延迟
                const delay = baseDelay * Math.pow(2, retryCount); // 指数退避：1s, 2s, 4s
                const jitter = Math.random() * 1000; // 添加随机抖动，避免雷群效应
                const totalDelay = delay + jitter;

                console.log(`[AI调用] 将在 ${Math.round(totalDelay)}ms 后进行第 ${retryCount + 2} 次重试`);

                // 通知前端重试状态
                this.socket.emit('status-update', {
                    status: `API调用失败，${Math.round(totalDelay / 1000)}秒后重试 (${retryCount + 1}/${maxRetries})`
                });


                await new Promise(resolve => setTimeout(resolve, totalDelay));

                // 递归重试
                return this.callAI(role, prompt, messageId, context, retryCount + 1);
            } else {
                // 所有重试都失败，抛出最终错误
                console.error(`[AI调用] 所有重试都失败，总共尝试了 ${maxRetries + 1} 次`);


                throw new AICallFinalError(
                    `AI调用最终失败，已重试 ${retryCount} 次: ${errorMessage}`,
                    retryCount,
                    currentError
                );
            }
        }
    }

    async performAICall(role, model, systemPrompt, prompt, messageId, callId, fullInput, startTime) {
        // 创建取消令牌
        const cancelToken = axios.CancelToken.source();
        this.currentAICall = cancelToken;
        this.currentMessageId = messageId;

        const requestConfig = {
            headers: {
                'Authorization': `Bearer ${this.apiConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 400000, // 400秒超时
            responseType: 'stream',
            cancelToken: cancelToken.token,
            validateStatus: function (status) {
                return status < 400; // 只有状态码小于400才认为是成功
            }
        };

        const requestData = {
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            stream: true
        };

        console.log(`[AI调用] 发送请求到: ${this.apiConfig.baseURL}/chat/completions`, `\n[AI调用] 使用API Key: ${this.apiConfig.apiKey.substring(0, 5)}...`);

        const response = await axios.post(`${this.apiConfig.baseURL}/chat/completions`, requestData, requestConfig);

        return new Promise((resolve, reject) => {
            let fullContent = '';
            let hasReceivedData = false;

            // 设置超时
            const timeout = setTimeout(() => {
                reject(new Error('AI响应超时'));
            }, 400000);

            response.data.on('data', (chunk) => {
                hasReceivedData = true;
                const lines = chunk.toString().split('\n');

                for (const line of lines) {
                    if (line.trim() === '') continue;

                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();

                        if (data === '[DONE]') {
                            clearTimeout(timeout);
                            const duration = Date.now() - startTime;
                            console.log(`[AI调用] 完成，总长度: ${fullContent.length}`);


                            // **新增逻辑：在这里发送完成事件**
                            if (messageId) {
                                this.socket.emit('stream-complete', {
                                    messageId: messageId,
                                    finalContent: fullContent
                                });
                            }

                            resolve(fullContent);
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0];

                            if (choice) {
                                // 检查是否完成
                                if (choice.finish_reason) {
                                    clearTimeout(timeout);
                                    const duration = Date.now() - startTime;
                                    console.log(`[AI调用] 完成，总长度: ${fullContent.length}`);


                                    // **新增逻辑：在这里发送完成事件**
                                    if (messageId) {
                                        this.socket.emit('stream-complete', {
                                            messageId: messageId,
                                            finalContent: fullContent
                                        });
                                    }

                                    resolve(fullContent);
                                    return;
                                }

                                // 检查多种可能的内容字段
                                const delta = choice.delta?.content ||
                                    choice.delta?.reasoning ||
                                    choice.message?.content ||
                                    choice.message?.reasoning;

                                if (delta && delta.length > 0) {
                                    fullContent += delta;

                                    // 发送流式更新
                                    if (messageId) {
                                        this.socket.emit('stream-update', {
                                            messageId: messageId,
                                            content: fullContent,
                                            delta: delta,
                                            speaker: role === 'cognito' ? 'Cognito' : 'Muse'
                                        });
                                    }
                                } else {
                                    // 调试：记录空内容的情况
                                    console.log(`[AI调用] 收到空内容，choice:`, JSON.stringify(choice, null, 2));
                                }
                            }
                        } catch (e) {
                            console.log(`[AI调用] JSON解析错误: ${e.message}, 数据: ${data.substring(0, 200)}`);
                            // 忽略解析错误，继续处理下一行
                        }
                    }
                }
            });

            response.data.on('end', () => {
                clearTimeout(timeout);
                this.currentAICall = null; // 清除当前调用引用
                this.currentMessageId = null;
                if (!hasReceivedData) {
                    reject(new Error('未收到任何数据'));
                } else {
                    // **核心修复：如果流结束时内容为空，则视为错误**
                    if (fullContent.length === 0) {
                        console.warn('[AI调用] 流结束但未收到任何有效内容。');
                        reject(new Error('API返回空响应'));
                    } else {
                        console.log(`[AI调用] 流结束，最终内容长度: ${fullContent.length}`);
                        resolve(fullContent);
                    }
                }
            });

            response.data.on('error', (error) => {
                clearTimeout(timeout);
                this.currentAICall = null; // 清除当前调用引用
                this.currentMessageId = null;
                console.error(`[AI调用] 流错误: ${error.message}`, error.response ? `| 状态码: ${error.response.status}` : '');
                if (error.response && error.response.data) {
                    error.response.data.on('data', chunk => {
                        const errorBody = chunk.toString();
                        console.error(`[AI调用] 错误响应体: ${errorBody}`);
                        reject(new Error(`流式响应错误: ${error.message} | 响应: ${errorBody}`));
                    });
                    error.response.data.on('end', () => {
                         // 如果没有数据块，则使用通用错误
                        reject(new Error(`流式响应错误: ${error.message}`));
                    });
                } else {
                    reject(new Error(`流式响应错误: ${error.message}`));
                }
            });
        });
    }


}

module.exports = DebateManager;