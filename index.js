const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");

// 加载环境变量
dotenv.config();

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
  if (typeof language !== 'string' || !language.trim()) {
    language = '';
  }
  const maxBackticks = (content.match(/`+/g) || []).reduce((max, curr) => Math.max(max, curr.length), 0);
  const backtickSequence = '`'.repeat(Math.max(3, maxBackticks + 1));
  return `${backtickSequence}${language}\n${content}\n${backtickSequence}`;
}

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
      if (codeExtensions.includes(extension) || extension === ".md") {
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

  // 创建临时目录用于存放单独的章节文件
  const tempDirPath = path.join(__dirname, uuidv4());
  fs.mkdirSync(tempDirPath);

  chapters.forEach((chapter, index) => {
    const tempFilePath = path.join(tempDirPath, `chapter${index}.md`);
    fs.writeFileSync(tempFilePath, `# ${chapter.title}\n${chapter.content}`);
    pandocArgs.push(tempFilePath);
  });

  try {
    execSync(`pandoc ${pandocArgs.join(" ")}`);
    const epubFilePath = path.join(process.cwd(), epubFileName);
    console.log(`Generated EPUB: ${epubFileName}`);
    console.log(`EPUB file path: ${epubFilePath}`);
  } catch (error) {
    console.error("Error generating EPUB:", error);
  } finally {
    // 清理临时目录
    fs.rmSync(tempDirPath, { recursive: true, force: true });
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