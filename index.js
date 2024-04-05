const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
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

async function generateEpubAndPdf(repoName, author, chapters) {
  const timestamp = new Date().toISOString().replace(/[-T:]/g, "").slice(0, 14);
  const epubFileName = `${repoName}_${timestamp}.epub`;
  const pdfFileName = `${repoName}_${timestamp}.pdf`;
  const metadata = {
    title: repoName,
    author: author,
    language: "en",
  };

  // 设置Pandoc的参数
  // prettier-ignore
  const pandocEpubArgs = [
    "-f", "markdown",
    "-t", "epub",
    "--metadata", `title=${metadata.title}`,
    "--metadata", `author=${metadata.author}`,
    "--metadata", `language=${metadata.language}`,
    "--toc",
    "--toc-depth", "2",
    "-o", epubFileName,
  ];

  // prettier-ignore
  const pandocPdfArgs = [
    "-f", "markdown",
    "-t", "pdf",
    "--metadata", `title=${metadata.title}`,
    "--metadata", `author=${metadata.author}`,
    "--pdf-engine", "xelatex",
    "-V", "mainfont='DejaVu Serif'",
    "-V", "monofont='DejaVu Sans Mono'",
    "-V", "papersize=a4",
    "-V", "geometry:margin=2cm",
    "--toc",
    "--toc-depth", "2", 
    "-o", pdfFileName,
  ];

  // 使用spawn启动Pandoc进程生成EPUB
  const pandocEpubProcess = spawn("pandoc", pandocEpubArgs);
  pandocEpubProcess.stdin.setDefaultEncoding("utf-8");

  // 将每个章节的内容写入Pandoc的stdin
  // TODO: 拆分章节到多个临时文件，保证epub不会从一个大文件中生成
  chapters.forEach((chapter) => {
    pandocEpubProcess.stdin.write(`# ${chapter.title}\n${chapter.content}\n\n`);
  });
  pandocEpubProcess.stdin.end();

  // 处理EPUB生成的输出和错误
  pandocEpubProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });
  pandocEpubProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });
  pandocEpubProcess.on("close", (code) => {
    if (code === 0) {
      const epubFilePath = path.join(process.cwd(), epubFileName);
      console.log(`生成的EPUB: ${epubFileName}`);
      console.log(`EPUB文件路径: ${epubFilePath}`);
    } else {
      console.error(`Pandoc EPUB进程退出，代码 ${code}`);
    }
  });

  // 使用spawn启动Pandoc进程生成PDF
  const pandocPdfProcess = spawn("pandoc", pandocPdfArgs);
  pandocPdfProcess.stdin.setDefaultEncoding("utf-8");

  // 将每个章节的内容写入Pandoc的stdin  
  chapters.forEach((chapter) => {
    pandocPdfProcess.stdin.write(`# ${chapter.title}\n${chapter.content}\n\n`);
  });
  pandocPdfProcess.stdin.end();

  // 处理PDF生成的输出和错误
  pandocPdfProcess.stdout.on("data", (data) => {
    console.log(`stdout: ${data}`);
  });
  pandocPdfProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`); 
  });
  pandocPdfProcess.on("close", (code) => {
    if (code === 0) {
      const pdfFilePath = path.join(process.cwd(), pdfFileName);
      console.log(`生成的PDF: ${pdfFileName}`);
      console.log(`PDF文件路径: ${pdfFilePath}`);
    } else {
      console.error(`Pandoc PDF进程退出，代码 ${code}`);
    }
  });
}

async function main() {
  const repoUrl = process.env.REPO_URL;
  const { repoName, author } = extractRepoDetails(repoUrl);
  const localDir = repoName;

  const fullRepoDir = cloneGitHubRepo(repoUrl, localDir);
  const chapters = [];
  const codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"];

  processFilesImproved(fullRepoDir, chapters, fullRepoDir, codeExtensions);
  await generateEpubAndPdf(repoName, author, chapters);
}

main();