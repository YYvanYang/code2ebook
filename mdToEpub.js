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

    // 使用正则表达式匹配<a>标签的href属性
    // <a>标签的href属性值如果不是以#开头或http开头的,就替换为#.
    const hrefRegex =
      /(<a\s+(?:[^>]*?\s+)?href\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^>\s]+)))/gi;
    htmlContent = htmlContent.replace(hrefRegex, (match, p1, p2, p3, p4) => {
      const href = p2 || p3 || p4;
      if (!href.startsWith("#") && !href.startsWith("http")) {
        return p1.replace(href, "#");
      }
      return match;
    });

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
  const addedFiles = new Set();

  htmlFiles.forEach((file, index) => {
    const id = `item${index + 1}`;
    const href = `${file}`;
    manifestItems += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
    spineItems += `<itemref idref="${id}"/>\n`;
  });

  if (coverImagePath) {
    const coverImageName = path.basename(coverImagePath);
    if (!addedFiles.has(`images/${coverImageName}`)) {
      manifestItems += `<item id="cover-image" href="images/${coverImageName}" media-type="image/jpeg" properties="cover-image"/>\n`;
      addedFiles.add(`images/${coverImageName}`);
    }
  }

  imageFiles.forEach((file, index) => {
    if (!addedFiles.has(file)) {
      const mediaType = getMediaType(file);
      manifestItems += `<item id="image${
        index + 1
      }" href="${file}" media-type="${mediaType}"/>\n`;
      addedFiles.add(file);
    }
  });

  resourcePaths.forEach((resourcePath, index) => {
    const resourceName = path.basename(resourcePath);
    if (!addedFiles.has(`images/${resourceName}`)) {
      const mediaType = getMediaType(resourcePath);
      manifestItems += `<item id="res${
        index + 1
      }" href="images/${resourceName}" media-type="${mediaType}"/>\n`;
      addedFiles.add(`images/${resourceName}`);
    }
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
    case ".svg":
      return "image/svg+xml;charset=utf-8";
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

  for (const file of markdownFiles) {
    const filePath = path.join(markdownDir, file);
    const htmlFilename = `${path.basename(file, ".md")}.xhtml`;
    const htmlFilePath = path.join(epubDir, htmlFilename);

    try {
      console.log(`转换Markdown文件: ${filePath}`);
      await convertMarkdownToHtmlPandoc(filePath, htmlFilePath);

      // 保存HTML文件路径而不是立即添加到zip
      // 正确的方式，确保不重复添加基目录前缀
      htmlFiles.push(htmlFilePath.replace(epubDir + path.sep, ""));
      console.log(`添加HTML文件1111: ${htmlFilePath}`);

      let title = path.basename(htmlFilename, ".xhtml");
      titles.push(title);

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
  }

  for (const file of files) {
    const filePath = path.join(markdownDir, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      const subDir = path.join(epubDir, file);
      fs.mkdirSync(subDir, { recursive: true });
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
              case "image/svg+xml;charset=utf-8":
                fileExtension = ".svg";
                break;
              default:
                console.warn(
                  `未知的图片类型: ${contentType}. 使用默认的.jpg扩展名. URL: ${url}`
                );
                fileExtension = path.extname(parsedUrl.pathname) || ".jpg"; // 默认使用.jpg
            }
          } else {
            console.warn(`无法获取图片类型. 使用URL的扩展名. URL: ${url}`);
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

async function processImages(zip, epubDir, htmlFiles) {
  const imageFiles = [];

  for (const htmlFile of htmlFiles) {
    const htmlFilePath = path.join(epubDir, htmlFile);
    let htmlContent = await fs.promises.readFile(htmlFilePath, "utf-8");

    const imgPattern = /<img[^>]+src="([^"]+)"[^>]*>/g;
    let match;
    let downloadPromises = [];

    while ((match = imgPattern.exec(htmlContent)) !== null) {
      const src = match[1];
      // 对于每个匹配项，创建一个闭包处理下载和替换
      const promise = (async () => {
        if (src.startsWith("http")) {
          try {
            const urlObj = new URL(src);
            const imageName =
              path.basename(urlObj.pathname) +
              (urlObj.search
                ? "_" +
                  encodeURIComponent(urlObj.search).replace(
                    /[^a-zA-Z0-9]/g,
                    "_"
                  )
                : "");
            // 确保目标路径包含文件名和后缀
            const imageDestPath = path.join(
              epubDir,
              "images",
              imageName.replace(/[^a-zA-Z0-9\.]/g, "_")
            );

            const downloadedImagePath = await downloadImage(src, imageDestPath);
            console.log(`下载图片: ${src} -> ${downloadedImagePath}`);

            const localImagePath = path
              .relative(epubDir, downloadedImagePath)
              .replace(/\\/g, "/");
            return { src, newSrc: localImagePath, status: "fulfilled" };
          } catch (error) {
            console.error(`图片下载失败: ${src}. 使用占位符替换.`, error);
            return {
              src,
              newSrc: "images/placeholder.svg",
              status: "rejected",
            };
          }
        } else {
          // 如果是本地路径，则直接返回
          return { src, newSrc: src, status: "fulfilled" };
        }
      })();
      downloadPromises.push(promise);
    }

    // 等待所有图片处理完成
    const results = await Promise.allSettled(downloadPromises);

    // 根据每个Promise的结果来替换HTML中的src属性
    results.forEach(({ status, value }) => {
      if (status === "fulfilled") {
        const { src, newSrc } = value;
        htmlContent = htmlContent.replace(`src="${src}"`, `src="${newSrc}"`);
        if (newSrc !== "images/placeholder.svg") {
          imageFiles.push(newSrc);
          // 将下载的图片添加到zip中
          zip.file(
            path.join(epubDir, newSrc).replace(/\\/g, "/"),
            fs.readFileSync(path.join(epubDir, newSrc))
          );
        }
      } else {
        // 对于rejected的情况，这里不做特殊处理，因为已在promise中使用占位符
      }
    });

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
    const imageFiles = await processImages(zip, epubDir, htmlFiles); // 更新HTML文件以包含下载的图片
    const uniqueImageFiles = [...new Set(imageFiles), "images/placeholder.svg"]; // 去除重复的图片文件

    // 将更新后的HTML文件添加到zip
    for (const htmlFile of htmlFiles) {
      const fullHtmlPath = path
        .join(epubDir, htmlFile)
        .replace(/\//g, path.sep);
      console.log(`添加HTML文件到EPUB: ${fullHtmlPath}`);
      const htmlContent = await fs.promises.readFile(fullHtmlPath, "utf-8");
      console.log(`添加HTML文件到EPUB2: ${htmlFile}`);
      zip.file(fullHtmlPath.replace(/\\/g, "/"), htmlContent);
    }

    // 继续之前的EPUB创建流程...
    const uuid = uuidv4();
    const contentOpf = generateContentOpf(
      metadata,
      htmlFiles,
      [...uniqueImageFiles],
      coverImagePath,
      resourcePaths,
      uuid
    );
    zip.file("OEBPS/content.opf", contentOpf);

    const tocXhtml = generateTocXhtml(htmlFiles, titles);
    zip.file("OEBPS/toc.xhtml", tocXhtml);

    const tocNcx = generateTocNcx(htmlFiles, titles, uuid, metadata);
    zip.file("OEBPS/toc.ncx", tocNcx);

    console.log("生成EPUB文件...");
    await zip.generateAsync({ type: "nodebuffer" }).then((content) => {
      fs.writeFileSync(epubPath, content);
      console.log(`EPUB创建成功: ${epubPath}`);
    });

    console.log("开始校验EPUB...");
    validateEpub(epubPath); 
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
