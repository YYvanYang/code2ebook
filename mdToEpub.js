const fs = require("fs");
const path = require("path");
const async = require("async");
const JSZip = require("jszip");
const { exec, execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { promisify } = require("util");
const http = require("http");
const https = require("https");

const execAsync = promisify(exec);

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.promises.access(dirPath);
  } catch (error) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}

async function cleanDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (process.platform === "win32") {
      fs.rmSync(directory, { recursive: true });
    } else {
      execSync(`rm -rf ${directory}`);
    }
  }
}

function addEpubNamespaceToHtml(htmlContent) {
  const htmlRegex = /<html(\s+[^>]*)?>/i;
  const match = htmlContent.match(htmlRegex);

  if (match) {
    const htmlTag = match[0];

    if (!htmlTag.includes("xmlns:epub")) {
      const modifiedHtmlTag = htmlTag.replace(
        />$/,
        ' xmlns:epub="http://www.idpf.org/2007/ops">'
      );
      const modifiedHtmlContent = htmlContent.replace(
        htmlRegex,
        modifiedHtmlTag
      );

      return modifiedHtmlContent;
    }
  }
  return htmlContent;
}

function replaceAlign(html) {
  const regex = /(<p\b[^>]*?\s)align=["']center["']([^>]*>)/gi;

  return html.replace(regex, '$1style="text-align: center;"$2');
}

async function convertMarkdownToHtmlPandoc(inputPath, outputPath) {
  try {
    await execAsync(
      `pandoc "${inputPath}" -f markdown -t html5 -s -o "${outputPath}"`
    );

    let htmlContent = await fs.promises.readFile(outputPath, "utf-8");

    htmlContent = addEpubNamespaceToHtml(htmlContent);

    htmlContent = replaceAlign(htmlContent);

    htmlContent = fixUnclosedSelfClosingTags(htmlContent);

    await fs.promises.writeFile(outputPath, htmlContent, "utf-8");
  } catch (error) {
    console.error(
      `Error converting markdown to HTML: ${inputPath}. Error: ${error}`
    );
    let htmlContent = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <head>
            <title>Conversion Error</title>
          </head>
          <body>
            <p>Failed to convert markdown file: ${inputPath}</p>
            <p>Error: ${error.message}</p>
          </body>
        </html>`;
    await fs.promises.writeFile(outputPath, htmlContent, "utf-8");
  }
}

function fixUnclosedSelfClosingTags(html) {
  const selfClosingTags = [
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ];

  selfClosingTags.forEach((tag) => {
    const regex = new RegExp(`<${tag}([^>]*[^/])>`, "g");
    html = html.replace(regex, `<${tag}$1 />`);
  });

  return html;
}

async function addCoverAndResources(zip, coverImagePath, resourcePaths) {
  try {
    if (coverImagePath) {
      const coverImageContent = fs.readFileSync(coverImagePath);
      await ensureDirectoryExists("OEBPS/images");
      zip.file("OEBPS/images/cover.jpg", coverImageContent);
    }

    for (const resourcePath of resourcePaths) {
      const resourceName = path.basename(resourcePath);
      const resourceContent = fs.readFileSync(resourcePath);
      await ensureDirectoryExists("OEBPS/images");
      zip.file(`OEBPS/images/${resourceName}`, resourceContent);
    }
  } catch (error) {
    console.error("Error adding cover or resources:", error);
  }
}

function generateContentOpf(
  metadata,
  htmlFiles,
  imageFiles,
  coverImagePath,
  resourcePaths,
  uuid
) {
  let manifestItems = "";
  let spineItems = "";

  htmlFiles.forEach((file, index) => {
    const id = `item${index + 1}`;
    const href = `${file}`;
    manifestItems += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
    spineItems += `<itemref idref="${id}"/>\n`;
  });

  if (coverImagePath) {
    const coverImageName = path.basename(coverImagePath);
    manifestItems += `<item id="cover-image" href="images/${coverImageName}" media-type="image/jpeg" properties="cover-image"/>\n`;
  }

  imageFiles.forEach((file, index) => {
    const mediaType = getMediaType(file);
    manifestItems += `<item id="image${
      index + 1
    }" href="${file}" media-type="${mediaType}"/>\n`;
  });

  resourcePaths.forEach((resourcePath, index) => {
    const resourceName = path.basename(resourcePath);
    const mediaType = getMediaType(resourcePath);
    manifestItems += `<item id="res${
      index + 1
    }" href="images/${resourceName}" media-type="${mediaType}"/>\n`;
  });

  const now = new Date();
  const formattedDate = now.toISOString().split(".")[0] + "Z";

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>${metadata.title}</dc:title>
            <dc:creator>${metadata.author}</dc:creator>
            <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
            <dc:language>en</dc:language>
            <meta property="dcterms:modified">${formattedDate}</meta>
        </metadata>
        <manifest>
            ${manifestItems}
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        </manifest>
        <spine toc="ncx">
            ${spineItems}
        </spine>
    </package>`;

  return contentOpf;
}

function getMediaType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function generateTocNcx(htmlFiles, titles, uuid) {
  let navPoints = "";

  htmlFiles.forEach((file, index) => {
    const id = `navPoint-${index + 1}`;
    const playOrder = index + 1;
    const navLabel = titles[index];
    const content = file;

    navPoints += `<navPoint id="${id}" playOrder="${playOrder}">
      <navLabel>
        <text>${navLabel}</text>
      </navLabel>
      <content src="${content}"/>
    </navPoint>\n`;
  });

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
  <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
      <meta name="dtb:uid" content="urn:uuid:${uuid}"/>
      <meta name="dtb:depth" content="1"/>
      <meta name="dtb:totalPageCount" content="0"/>
      <meta name="dtb:maxPageNumber" content="0"/>
    </head>
    <docTitle>
      <text>${metadata.title}</text>
    </docTitle>
    <navMap>
      ${navPoints}
    </navMap>
  </ncx>`;

  return tocNcx;
}

function generateTocXhtml(htmlFiles, titles) {
  let tocItems = "";

  htmlFiles.forEach((file, index) => {
    const href = file;
    const title = titles[index];
    tocItems += `<li><a href="${href}">${title}</a></li>\n`;
  });

  const tocXhtml = `<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
    <head>
        <title>目录</title>
    </head>
    <body>
        <nav epub:type="toc" id="toc">
            <h1>目录</h1>
            <ol>
                ${tocItems}
            </ol>
        </nav>
    </body>
    </html>`;

  return tocXhtml;
}

function initializeEpubStructure(zip) {
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.folder("META-INF");
  zip.folder("OEBPS");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
    </container>`
  );
}

function countMarkdownFiles(directory) {
  let count = 0;
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const filePath = path.join(directory, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      count += countMarkdownFiles(filePath);
    } else if (path.extname(file) === ".md") {
      count++;
    }
  }
  return count;
}

async function createPlaceholderImage(width, height, text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#E0E0E0"/>
    <text x="50%" y="50%" font-size="24" text-anchor="middle" alignment-baseline="middle" font-family="Arial, sans-serif" fill="#424242">${text}</text>
  </svg>`;

  const placeholder = "OEBPS/images/placeholder.svg";
  await fs.promises.mkdir(path.dirname(placeholder), { recursive: true });
  await fs.promises.writeFile(placeholder, svg, "utf-8");
}

async function processMarkdownFiles(
  zip,
  markdownDir,
  epubDir,
  htmlFiles,
  titles,
  processedFiles
) {
  const files = fs.readdirSync(markdownDir);
  const markdownFiles = files.filter((file) => path.extname(file) === ".md");

  await createPlaceholderImage(400, 300, "Placeholder");
  zip.file(
    "OEBPS/images/placeholder.svg",
    fs.readFileSync("OEBPS/images/placeholder.svg")
  );

  const convertQueue = async.queue(async (file, callback) => {
    const filePath = path.join(markdownDir, file);
    const htmlFilename = `${path.basename(file, ".md")}.xhtml`;
    const htmlFilePath = path.join(epubDir, htmlFilename);
    try {
      console.log(`转换Markdown文件: ${filePath}`);
      await convertMarkdownToHtmlPandoc(filePath, htmlFilePath);

      let htmlFileFullName = path.join(epubDir, htmlFilename);
      htmlFileFullName = htmlFileFullName.replace(/\\/g, "/");

      const content = await fs.promises.readFile(htmlFileFullName, "utf-8");
      zip.file(htmlFileFullName, content);

      htmlFiles.push(htmlFileFullName.replace("OEBPS/", ""));
      let relativePathOfHtmlPath = htmlFileFullName.replace("OEBPS/", "");
      relativePathOfHtmlPath = relativePathOfHtmlPath.replace(/\\/g, " > ");
      relativePathOfHtmlPath = relativePathOfHtmlPath.replace(/\//g, " > ");
      relativePathOfHtmlPath = relativePathOfHtmlPath.replace(".xhtml", "");

      titles.push(relativePathOfHtmlPath);
      console.log(`添加章节标题: `, relativePathOfHtmlPath);
      processedFiles.count++;
      const percentage = (
        (processedFiles.count / processedFiles.total) *
        100
      ).toFixed(2);
      console.log(
        `转换进度: ${processedFiles.count}/${processedFiles.total} (${percentage}%)`
      );
    } catch (error) {
      console.error(`Error adding file to EPUB: ${error}`);
    }

    callback();
  }, 15);

  convertQueue.push(markdownFiles);

  await new Promise((resolve) => {
    convertQueue.drain(resolve);
  });

  for (const file of files) {
    const filePath = path.join(markdownDir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const subDir = path.join(epubDir, file);
      fs.mkdirSync(subDir, { recursive: true });
      console.log(`创建子目录: ${subDir}`);
      await processMarkdownFiles(
        zip,
        filePath,
        subDir,
        htmlFiles,
        titles,
        processedFiles
      );
    }
  }
}

// 修复后的 downloadImage 函数
async function downloadImage(url, dest, timeout = 10000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const protocol = parsedUrl.protocol === "https:" ? https : http;

      const requestOptions = {
        method: "GET",
        timeout: timeout,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
        },
      };

      const request = protocol.request(url, requestOptions, (response) => {
        if (response.statusCode === 200) {
          const contentType = response.headers["content-type"];
          let fileExtension = "";

          if (contentType) {
            switch (contentType) {
              case "image/jpeg":
                fileExtension = ".jpg";
                break;
              case "image/png":
                fileExtension = ".png";
                break;
              case "image/gif":
                fileExtension = ".gif";
                break;
              case "image/webp":
                fileExtension = ".webp";
                break;
              case "image/svg+xml":
                fileExtension = ".svg";
                break;
              default:
                fileExtension = path.extname(parsedUrl.pathname) || ".jpg"; // 默认使用.jpg
            }
          } else {
            fileExtension = path.extname(parsedUrl.pathname);
          }

          // 检查目标路径是否已经包含了正确的文件扩展名
          const destExtension = path.extname(dest);
          const destBaseName = path.basename(dest, destExtension);
          const destWithExtension =
            destExtension === fileExtension
              ? dest
              : path.format({
                  dir: path.dirname(dest),
                  name: destBaseName,
                  ext: fileExtension,
                });

          const fileStream = fs.createWriteStream(destWithExtension);
          response.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close();
            resolve(destWithExtension);
          });
        } else if (response.statusCode >= 300 && response.statusCode < 400) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            downloadImage(redirectUrl, dest, timeout)
              .then(resolve)
              .catch(reject);
          } else {
            reject(
              new Error(
                `无法重定向图片. 状态码: ${response.statusCode}, URL: ${url}`
              )
            );
          }
        } else {
          reject(
            new Error(
              `无法下载图片. 状态码: ${response.statusCode}, URL: ${url}`
            )
          );
        }
      });

      request.on("error", (error) => {
        reject(error);
      });

      request.on("timeout", () => {
        request.destroy();
        reject(new Error(`下载图片超时. URL: ${url}`));
      });

      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

// 调整 processImages 函数以解决文件名重复问题
async function processImages(zip, epubDir, htmlFiles) {
  const imageFiles = [];

  for (const htmlFile of htmlFiles) {
    const htmlFilePath = path.join(epubDir, htmlFile);
    let htmlContent = await fs.promises.readFile(htmlFilePath, "utf-8");

    const imgPattern = /<img[^>]+src="([^"]+)"[^>]*>/g;
    let match;

    while ((match = imgPattern.exec(htmlContent)) !== null) {
      const src = match[1];

      if (src.startsWith("http")) {
        // 使用URL的pathname和search部分生成唯一文件名
        const urlObj = new URL(src);
        const imageName =
          path.basename(urlObj.pathname) +
          (urlObj.search
            ? "_" +
              encodeURIComponent(urlObj.search).replace(/[^a-zA-Z0-9]/g, "_")
            : "");
        const imageDestPath = path.join(
          epubDir,
          "images",
          imageName.replace(/[^a-zA-Z0-9\.]/g, "_")
        );

        try {
          const downloadedImagePath = await downloadImage(src, imageDestPath);
          console.log(`下载图片: ${src} -> ${downloadedImagePath}`);

          const localImagePath = path
            .relative(epubDir, downloadedImagePath)
            .replace(/\\/g, "/");
          htmlContent = htmlContent.replace(
            match[0],
            `<img src="${localImagePath}" alt="">`
          );

          imageFiles.push(localImagePath);
          zip.file(localImagePath, fs.readFileSync(downloadedImagePath));
        } catch (error) {
          console.error(`图片下载失败: ${src}. 使用占位符替换.`, error);
          htmlContent = htmlContent.replace(
            match[0],
            `<img src="images/placeholder.svg" alt="">`
          );
        }
      } else {
        const normalizedImagePath = path.normalize(src);
        const absoluteImagePath = path.join(epubDir, normalizedImagePath);

        if (fs.existsSync(absoluteImagePath)) {
          console.log(`本地图片已存在: ${absoluteImagePath}`);

          const epubImagePath = normalizedImagePath.replace(/\\/g, "/");
          htmlContent = htmlContent.replace(
            match[0],
            `<img src="${epubImagePath}" alt="">`
          );

          imageFiles.push(epubImagePath);
          zip.file(absoluteImagePath, fs.readFileSync(absoluteImagePath));
        } else {
          console.warn(`本地图片不存在: ${absoluteImagePath}. 使用占位符替换.`);
          htmlContent = htmlContent.replace(
            match[0],
            `<img src="images/placeholder.svg" alt="">`
          );
        }
      }
    }

    await fs.promises.writeFile(htmlFilePath, htmlContent, "utf-8");
  }

  return imageFiles;
}

async function createEpub(
  markdownDir,
  epubPath,

  metadata,
  coverImagePath,
  resourcePaths = []
) {
  console.log("开始创建EPUB...");

  const zip = new JSZip();
  initializeEpubStructure(zip);

  const htmlFiles = [];

  const titles = [];

  const epubDir = "OEBPS";
  console.log(`创建EPUB目录: ${epubDir}`);
  await cleanDirectory(epubDir);
  await ensureDirectoryExists(epubDir);

  try {
    console.log("处理Markdown文件...");
    const totalFiles = countMarkdownFiles(markdownDir);
    const processedFiles = { count: 0, total: totalFiles };
    await processMarkdownFiles(
      zip,
      markdownDir,
      epubDir,
      htmlFiles,
      titles,
      processedFiles
    );

    console.log("处理图片资源...");
    const imageFiles = await processImages(zip, epubDir, htmlFiles);

    await addCoverAndResources(zip, coverImagePath, resourcePaths);

    console.log("生成content.opf...");
    const uuid = uuidv4();
    const contentOpf = generateContentOpf(
      metadata,
      htmlFiles,
      imageFiles,
      coverImagePath,
      resourcePaths,
      uuid
    );
    zip.file("OEBPS/content.opf", contentOpf);

    console.log("生成toc.xhtml...");
    const tocXhtml = generateTocXhtml(htmlFiles, titles);
    zip.file("OEBPS/toc.xhtml", tocXhtml);

    console.log("生成toc.ncx...");
    const tocNcx = generateTocNcx(htmlFiles, titles, uuid);
    zip.file("OEBPS/toc.ncx", tocNcx);

    console.log("生成EPUB文件...");
    await zip.generateAsync({ type: "nodebuffer" }).then((content) => {
      fs.writeFileSync(epubPath, content);
      console.log(`EPUB创建成功: ${epubPath}`);
    });

    console.log("开始校验EPUB...");
    return validateEpub(epubPath);
  } catch (error) {
    console.error("EPUB创建失败:", error);
  }
}

async function validateEpub(epubPath) {
  try {
    const { stdout, stderr } = await execAsync(
      `java -jar epubcheck/epubcheck.jar "${epubPath}"`
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

// 示例用法
const markdownDir = "markdown/rolldown";
const epubPath = "output.epub";
const metadata = {
  title: "电子书标题",
  author: "作者",
};

// const coverImagePath = "cover.jpg";
// const resourcePaths = ["OEBPS/images"];

createEpub(
  markdownDir,
  epubPath,
  metadata
  // coverImagePath,
  // resourcePaths
).catch(console.error);
