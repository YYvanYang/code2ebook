const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");

// 加载环境变量
dotenv.config();

// 动态获取工作目录路径
const workDir = path.join(__dirname, ".");

// 设置Node.js进程的当前工作目录
process.chdir(workDir);

// 临时目录
const tempDirRelativePath = "t";

// 字符集
const asciiChars = [
  ...Array.from({ length: 10 }, (_, i) => String.fromCharCode(48 + i)), // 0-9
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)), // a-z
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), // A-Z
];

function ensureRepoDirExists() {
  const repoDir = "repo";
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir);
  }
}

function removeDirectory(directory) {
  if (process.platform === "win32") {
    fs.rmSync(directory, { recursive: true });
  } else {
    execSync(`rm -rf ${directory}`);
  }
}

function cloneGitHubRepo(repoUrl, localDir) {
  ensureRepoDirExists();
  const fullPath = path.join("repo", localDir);
  if (fs.existsSync(fullPath)) {
    removeDirectory(fullPath);
  }
  execSync(`git clone ${repoUrl} ${fullPath}`);
  return fullPath;
}

function extractRepoDetails(repoUrl) {
  const parts = repoUrl.split("/");
  const repoName = parts[parts.length - 1].replace(".git", "");
  const author = parts.length > 1 ? parts[parts.length - 2] : "Unknown Author";
  return { repoName, author };
}

function codeToMarkdown(content, language) {
  if (typeof language !== "string" || !language.trim()) {
    language = "";
  }
  const maxBackticks = (content.match(/`+/g) || []).reduce(
    (max, curr) => Math.max(max, curr.length),
    0
  );
  const backtickSequence = "`".repeat(Math.max(3, maxBackticks + 1));
  return `${backtickSequence}${language}\n${content}\n${backtickSequence}`;
}

function processFilesImproved(
  dir,
  chapters,
  fullRepoDir,
  codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"]
) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      processFilesImproved(filePath, chapters, fullRepoDir, codeExtensions);
    } else {
      const content = fs.readFileSync(filePath, "utf-8");
      const extension = path.extname(file);
      let chapterContent;
      if (codeExtensions.includes(extension) || extension === ".md") {
        const language = extension.slice(1);
        chapterContent = codeExtensions.includes(extension)
          ? codeToMarkdown(content, language)
          : content;
        const relativePath = path.relative(fullRepoDir, filePath);
        const chapterTitle = relativePath
          .replace(/_/g, " ")
          .replace(/\//g, " > ")
          .replace(/\\/g, " > ");
        chapters.push({ title: chapterTitle, content: chapterContent });
      }
    }
  });
}

// 生成文件名
function generateFileName(index) {
  let fileName = "";
  while (index >= 0) {
    fileName = asciiChars[index % asciiChars.length] + fileName;
    index = Math.floor(index / asciiChars.length) - 1;
  }
  return fileName;
}

// 创建临时文件
function createTempFiles(pandocArgs, chapters) {
  // 确保临时目录存在
  if (fs.existsSync(tempDirRelativePath)) {
    fs.rmSync(tempDirRelativePath, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDirRelativePath);

  chapters.forEach((chapter, index) => {
    const tempFileName = generateFileName(index);
    const tempFilePath = path.join(tempDirRelativePath, tempFileName);
    fs.writeFileSync(tempFilePath, `# ${chapter.title}\n${chapter.content}`);
    pandocArgs.push(tempFilePath);
  });

  return pandocArgs;
}

async function generateEpub(repoName, author, chapters) {
  const timestamp = new Date().toISOString().replace(/[-T:]/g, "").slice(0, 14);
  const epubFileName = `${repoName}_${timestamp}.epub`;
  const metadata = {
    title: repoName,
    author: author,
    language: "en",
  };

  // prettier-ignore
  const pandocArgs = [
    "-f", "markdown",
    "-t", "epub",
    "--metadata", `title=${metadata.title}`,
    "--metadata", `author=${metadata.author}`,
    "--metadata", `language=${metadata.language}`,
    "--toc", 
    "--toc-depth", "2",
    "-o", epubFileName,
  ];

  createTempFiles(pandocArgs, chapters);

  try {
    execSync(`pandoc ${pandocArgs.join(" ")}`);
    const epubFilePath = path.join(process.cwd(), epubFileName);
    console.log(`Generated EPUB: ${epubFileName}`);
    console.log(`EPUB file path: ${epubFilePath}`);
  } catch (error) {
    console.error("Error generating EPUB:", error);
  } finally {
    // 清理临时目录
    fs.rmSync(tempDirRelativePath, { recursive: true, force: true });
  }
}

async function main() {
  const repoUrl = process.env.REPO_URL;
  const { repoName, author } = extractRepoDetails(repoUrl);
  const localDir = repoName;

  const fullRepoDir = cloneGitHubRepo(repoUrl, localDir);
  const chapters = [];
  const codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"];

  processFilesImproved(fullRepoDir, chapters, fullRepoDir, codeExtensions);
  await generateEpub(repoName, author, chapters);
}

main();
