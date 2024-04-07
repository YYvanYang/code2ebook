const fs = require("fs");
const path = require("path");
const { exec, execSync, spawn } = require("child_process");
const dotenv = require("dotenv");
// const zlib = require("zlib");
const { promisify } = require("util");

const execAsync = promisify(exec);

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

function shouldExclude(file, excludeDirs, excludeFiles, excludeExtensions) {
  if (file.startsWith(".")) {
    return true;
  }
  if (excludeDirs.includes(file)) {
    return true;
  }
  if (excludeFiles.includes(file)) {
    return true;
  }
  const extension = path.extname(file);
  if (excludeExtensions.includes(extension)) {
    return true;
  }
  return false;
}

function processFilesImproved(
  dir,
  chapters,
  fullRepoDir,
  codeExtensions = [
    ".js",
    ".ts",
    ".py",
    ".jsx",
    ".tsx",
    ".rs",
    ".sql",
    ".json",
  ],
  excludeDirs = ["node_modules", ".git"],
  excludeFiles = [".gitignore"],
  excludeExtensions = [".lock", ".toml", ".yaml", ".yml"]
) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      if (!shouldExclude(file, excludeDirs, excludeFiles, excludeExtensions)) {
        processFilesImproved(filePath, chapters, fullRepoDir, codeExtensions, excludeDirs, excludeFiles, excludeExtensions);
      }
    } else {
      if (!shouldExclude(file, excludeDirs, excludeFiles, excludeExtensions)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const extension = path.extname(file);
        let chapterContent;

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

async function validateEpub(epubPath) {
  try {
    console.log("正在使用 EPUBCheck 校验生成的 EPUB 文件...");
    const { stdout, stderr } = await execAsync(
      `java -jar epubcheck-5.1.0/epubcheck.jar "${epubPath}"`
    );
    console.log("EPUBCheck 校验结果:");
    console.log(stdout);
    if (stderr) {
      console.error("EPUBCheck 错误:");
      console.error(stderr);
    }
  } catch (error) {
    console.error("EPUBCheck 执行失败:", error);
  }
}

async function generateEpub(repoName, author, chapters) {
  const timestamp = new Date().toISOString().replace(/[-T:]/g, "").slice(0, 14);
  const epubFileName = `${repoName}_${timestamp}.epub`;
  const metadata = {
    title: repoName,
    author: author,
    language: "en",
  };

  // 设置Pandoc的参数
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

  // 使用spawn启动Pandoc进程
  const pandocProcess = spawn("pandoc", pandocArgs);

  pandocProcess.stdin.setDefaultEncoding("utf-8");

  // 将每个章节的内容写入Pandoc的stdin
  chapters.forEach((chapter) => {
    pandocProcess.stdin.write(`# ${chapter.title}\n${chapter.content}\n\n`);
  });

  // 结束输入
  pandocProcess.stdin.end();

  // 处理输出和错误
  pandocProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });

  pandocProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });

  // 当Pandoc进程关闭时，检查是否成功生成EPUB文件
  pandocProcess.on("close", (code) => {
    if (code === 0) {
      const epubFilePath = path.join(process.cwd(), epubFileName);
      console.log(`生成的EPUB: ${epubFileName}`);
      console.log(`EPUB文件路径: ${epubFilePath}`);
      validateEpub(epubFilePath);
    } else {
      console.error(`Pandoc进程退出，代码 ${code}`);
    }
  });
}

async function main() {
  const repoUrl = process.env.REPO_URL;
  const { repoName, author } = extractRepoDetails(repoUrl);
  const localDir = repoName;

  const fullRepoDir = cloneGitHubRepo(repoUrl, localDir);
  const chapters = [];
  const codeExtensions = [
    ".js",
    ".ts",
    ".py",
    ".jsx",
    ".tsx",
    ".rs",
    ".sql",
    ".json",
  ];

  processFilesImproved(fullRepoDir, chapters, fullRepoDir, codeExtensions);
  await generateEpub(repoName, author, chapters);
}

main();
