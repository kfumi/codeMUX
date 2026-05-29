import { useEffect, useCallback } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePreviewStore } from '../../stores/previewStore';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const { messages, isLoading, isStreaming, streamingContent, fetchMessages, sendMessage } = useChatStore();
  const { sessions } = useSessionStore();
  const { setOpen, setFiles } = usePreviewStore();

  const session = sessions.find((s) => s.id === sessionId);
  const sessionMessages = messages[sessionId] || [];
  const currentStreamingContent = streamingContent[sessionId] || '';

  useEffect(() => {
    fetchMessages(sessionId);
  }, [sessionId, fetchMessages]);

  const handleSend = async (content: string) => {
    await sendMessage(sessionId, content);
  };

  const handleFileClick = useCallback((path: string) => {
    setOpen(true);
    usePreviewStore.getState().selectFile(path);
    // Add file to files list if not already present
    const currentFiles = usePreviewStore.getState().files;
    if (!currentFiles.find((f) => f.path === path)) {
      setFiles([...currentFiles, { path }]);
    }
  }, [setOpen, setFiles]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3">
        <h2 className="font-semibold">{session?.title || '对话'}</h2>
      </div>
      <MessageList
        messages={sessionMessages}
        isLoading={isLoading}
        isStreaming={isStreaming}
        streamingContent={currentStreamingContent}
        onFileClick={handleFileClick}
      />
      <ChatInput onSend={handleSend} isLoading={isLoading || isStreaming} />
    </div>
  );
}
