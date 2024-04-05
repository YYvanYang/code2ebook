const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");

// 加载环境变量
dotenv.config();

function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function removeDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (process.platform === "win32") {
      execSync(`rmdir /s /q "${directory}"`);
    } else {
      execSync(`rm -rf "${directory}"`);
    }
  }
}

function cloneGitHubRepo(repoUrl, localDir) {
  ensureDirExists(path.dirname(localDir));
  removeDirectory(localDir);
  execSync(`git clone ${repoUrl} "${localDir}"`);
  return path.resolve(localDir);
}

function extractRepoDetails(repoUrl) {
  const parts = repoUrl.split("/");
  const repoName = parts[parts.length - 1].replace(".git", "");
  const author = parts.length > 1 ? parts[parts.length - 2] : "Unknown Author";
  return { repoName, author };
}

function codeToMarkdown(content, language) {
  const backtickSequence = "```";
  return `${backtickSequence}${language}\n${content}\n${backtickSequence}`;
}

function processFiles(dir, baseDir, codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"]) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const subDir = path.join(baseDir, file);
      ensureDirExists(subDir);
      processFiles(filePath, subDir, codeExtensions);
    } else {
      const content = fs.readFileSync(filePath, "utf-8");
      const extension = path.extname(file);
      if (codeExtensions.includes(extension) || extension === ".md") {
        const language = extension.slice(1);
        const markdownContent = codeExtensions.includes(extension)
          ? codeToMarkdown(content, language)
          : content;
        const markdownPath = path.join(baseDir, `${path.basename(file, extension)}.md`);
        fs.writeFileSync(markdownPath, markdownContent);
      }
    }
  });
}

async function main() {
  try {
    const repoUrl = process.env.REPO_URL;
    const { repoName } = extractRepoDetails(repoUrl);
    const localDir = path.join("repo", repoName);

    const fullRepoDir = cloneGitHubRepo(repoUrl, localDir);
    const baseDir = path.join("markdown", repoName);
    removeDirectory(baseDir);
    ensureDirExists(baseDir);

    const codeExtensions = [".js", ".ts", ".py", ".jsx", ".tsx", ".rs"];
    processFiles(fullRepoDir, baseDir, codeExtensions);

    console.log(`Markdown files generated in ${baseDir}`);
  } catch (error) {
    console.error("An error occurred:", error);
    process.exit(1);
  }
}

main();