export interface AgentInputImage {
  name: string;
  mediaType: string;
  dataUrl: string;
  size?: number;
}

export interface AgentInputPayload {
  text: string;
  images?: AgentInputImage[];
}

export interface UserAttachmentPreview {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
}
