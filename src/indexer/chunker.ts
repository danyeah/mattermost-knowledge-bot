export interface DocumentChunk {
  chunkIndex: number;
  heading: string;
  content: string;
}

const MIN_CHUNK_LENGTH = 80;

export function chunkDocument(text: string, title: string): DocumentChunk[] {
  const lines = text.split("\n");
  const chunks: DocumentChunk[] = [];
  let currentHeading = title;
  let currentLines: string[] = [];
  let chunkIndex = 0;

  const flush = () => {
    const content = currentLines.join("\n").trim();
    if (content.length >= MIN_CHUNK_LENGTH) {
      chunks.push({ chunkIndex: chunkIndex++, heading: currentHeading, content });
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentHeading = line.slice(3).trim();
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}
