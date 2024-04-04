const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");

// 加载环境变量
dotenv.config();

// 确保存在'repo'目录
function ensureRepoDirExists() {
  const repoDir = "repo";
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir);
  }
}

function removeDirectory(directory) {
  if (process.platform === "win32") {
    fs.rmdirSync(directory, { recursive: true });
  } else {
    execSync(`rm -rf ${directory}`);
  }
}

// 克隆GitHub仓库
function cloneGitHubRepo(repoUrl, localDir) {
  ensureRepoDirExists();
  const fullPath = path.join("repo", localDir);
  if (fs.existsSync(fullPath)) {
    removeDirectory(fullPath);
  }
  execSync(`git clone ${repoUrl} ${fullPath}`);
  return fullPath;
}

// 从URL提取仓库名称和作者
function extractRepoDetails(repoUrl) {
  const parts = repoUrl.split("/");
  const repoName = parts[parts.length - 1].replace(".git", "");
  const author = parts.length > 1 ? parts[parts.length - 2] : "Unknown Author";
  return { repoName, author };
}

// 转换代码为Markdown格式
function codeToMarkdown(content, language) {
  // 直接使用Markdown的代码块语法
  return `\`\`\`${language}\n${content}\n\`\`\``;
}

// 改进后的文件处理函数
function processFilesImproved(
  dir,
  chapters,
  fullRepoDir,
  codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"],
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
      if (codeExtensions.includes(extension)) {
        const language = extension.slice(1);
        chapterContent = codeExtensions.includes(extension)
          ? codeToMarkdown(content, language)
          : content;
        const relativePath = path.relative(fullRepoDir, filePath);
        const chapterTitle = relativePath
          .replace(/_/g, " ")
          .replace(/\//g, " > ");
        chapters.push({ title: chapterTitle, content: chapterContent });
      }
    }
  });
}

// 调用Pandoc生成EPUB文件
async function generateEpub(repoName, author, chapters) {
  const timestamp = new Date().toISOString().replace(/[-T:]/g, "").slice(0, 14);
  const epubFileName = `${repoName}_${timestamp}.epub`;
  const metadata = {
    title: repoName,
    author: author,
    language: "en",
  };

  const pandocArgs = [
    "-f",
    "markdown",
    "-t",
    "epub",
    "--metadata",
    `title=${metadata.title}`,
    "--metadata",
    `author=${metadata.author}`,
    "--metadata",
    `language=${metadata.language}`,
    "--toc",
    "--toc-depth",
    "2",
    "-o",
    epubFileName,
  ];

  const chapterContents = chapters
    .map((chapter) => `# ${chapter.title}\n${chapter.content}`)
    .join("\n\n");
  const tempFilePath = path.join(__dirname, uuidv4());
  fs.writeFileSync(tempFilePath, chapterContents);
  pandocArgs.push(tempFilePath);

  try {
    execSync(`pandoc ${pandocArgs.join(" ")}`);
    const epubFilePath = path.join(process.cwd(), epubFileName);
    console.log(`Generated EPUB: ${epubFileName}`);
    console.log(`EPUB file path: ${epubFilePath}`);
  } catch (error) {
    console.error("Error generating EPUB:", error);
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
  const codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"];

  processFilesImproved(fullRepoDir, chapters, fullRepoDir, codeExtensions);

  // 生成EPUB文件
  await generateEpub(repoName, author, chapters);
}

main();
