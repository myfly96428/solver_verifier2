const DebateManager = require('./src/debate-manager');

// 模拟Socket.IO对象
class MockSocket {
    emit(event, data) {
        console.log(`[Socket] ${event}:`, JSON.stringify(data, null, 2));
    }
}

// 测试指数退避重试逻辑
async function testRetryLogic() {
    console.log('=== 测试指数退避重试逻辑 ===\n');
    
    const mockSocket = new MockSocket();
    
    // 使用会返回404错误的URL
    const invalidApiConfig = {
        apiKey: 'test-key',
        baseURL: 'https://httpbin.org/status/404'
    };
    
    const debateManager = new DebateManager(invalidApiConfig, mockSocket);
    
    const startTime = Date.now();
    
    try {
        console.log('开始测试API调用失败和重试...');
        
        await debateManager.callAI('cognito', '测试问题', 'test-message-id');
        
        console.log('意外成功，未触发错误');
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.log(`\n测试完成，总耗时: ${duration}ms`);
        console.log('错误类型:', error.constructor.name);
        console.log('错误信息:', error.message || '无消息');
        console.log('重试次数:', error.retryCount || 0);
        console.log('错误状态码:', error.response?.status || '无状态码');
        console.log('是否是axios错误:', error.isAxiosError || false);
        
        if (error.constructor.name === 'AICallFinalError') {
            console.log('✅ 成功捕获到AICallFinalError，重试逻辑工作正常');
            console.log('预期重试次数: 3, 实际重试次数:', error.retryCount);
        } else {
            console.log('❌ 未捕获到预期的AICallFinalError');
        }
    }
}

// 运行测试
testRetryLogic().catch(console.error);