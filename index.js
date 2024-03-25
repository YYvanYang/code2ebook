const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
const highlight = require('highlight.js');

// 加载环境变量
dotenv.config();

// 确保存在'repo'目录
function ensureRepoDirExists() {
  const repoDir = 'repo';
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir);
  }
}

// 克隆GitHub仓库
function cloneGitHubRepo(repoUrl, localDir) {
  ensureRepoDirExists();
  const fullPath = path.join('repo', localDir);
  if (fs.existsSync(fullPath)) {
    execSync(`rm -rf ${fullPath}`);
  }
  execSync(`git clone ${repoUrl} ${fullPath}`);
  return fullPath;
}

// 从URL提取仓库名称和作者
function extractRepoDetails(repoUrl) {
  const parts = repoUrl.split('/');
  const repoName = parts[parts.length - 1].replace('.git', '');
  const author = parts.length > 1 ? parts[parts.length - 2] : 'Unknown Author';
  return { repoName, author };
}

// 对代码进行语法高亮
function highlightCode(code, language) {
  const highlightedCode = highlight.highlight(code, { language }).value;
  return `<pre><code class="hljs ${language}">${highlightedCode}</code></pre>`;
}

// 调用Pandoc生成EPUB文件
async function generateEpub(repoName, author, chapters) {
  const timestamp = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 14);
  const epubFileName = `${repoName}_${timestamp}.epub`;
  const metadata = {
    title: repoName,
    author: author,
    language: 'en',
  };

  const pandocArgs = [
    '-f', 'html',
    '-t', 'epub',
    '--metadata', `title=${metadata.title}`,
    '--metadata', `author=${metadata.author}`,
    '--metadata', `language=${metadata.language}`,
    '--toc',
    '--toc-depth', '2',
    // '--epub-cover-image', 'cover.jpg',
    // '--css', 'style.css',
    '-o', epubFileName,
  ];

  const chapterContents = chapters.map((chapter) => `<h1>${chapter.title}</h1>${chapter.content}`).join('\n');
  const tempFilePath = path.join(__dirname, uuidv4());
  fs.writeFileSync(tempFilePath, chapterContents);
  pandocArgs.push(tempFilePath);

  try {
    execSync(`pandoc ${pandocArgs.join(' ')}`);
    const epubFilePath = path.join(process.cwd(), epubFileName);
    console.log(`Generated EPUB: ${epubFileName}`);
    console.log(`EPUB file path: ${epubFilePath}`);
  } catch (error) {
    console.error('Error generating EPUB:', error);
  } finally {
    fs.unlinkSync(tempFilePath);
  }
}

// 主函数
async function main() {
  const repoUrl = process.env.REPO_URL;
  const { repoName, author } = extractRepoDetails(repoUrl);
  const localDir = repoName;

  // 克隆GitHub仓库
  const fullRepoDir = cloneGitHubRepo(repoUrl, localDir);

  // 遍历目录并处理文件
  const chapters = [];
  const codeExtensions = ['.js', '.ts', '.py', '.jsx', '.tsx', '.rs', '.md'];

  function processFiles(dir, parentPath = '') {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
      const filePath = path.join(dir, file);
      const relativePath = path.join(parentPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) {
        processFiles(filePath, relativePath);
      } else if (codeExtensions.includes(path.extname(file))) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const language = path.extname(file).slice(1);
        const highlightedCode = highlightCode(content, language);
        const relativePath = path.relative(fullRepoDir, filePath);
        const chapterTitle = relativePath.replace(/_/g, ' ').replace(/\//g, ' > ');
        const chapterContent = `<h1>${file}</h1>${highlightedCode}`;
        chapters.push({ title: chapterTitle, content: chapterContent });
      }
    });
  }

  processFiles(fullRepoDir);

  // 生成EPUB文件
  await generateEpub(repoName, author, chapters);
}

main();