const fs = require("fs");
const path = require("path");
const async = require("async");
const JSZip = require("jszip");
const { exec, execSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { promisify } = require("util");

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
  // 使用正则表达式查找<html>标签
  const htmlRegex = /<html(\s+[^>]*)?>/i;
  const match = htmlContent.match(htmlRegex);

  if (match) {
    const htmlTag = match[0];

    // 检查是否已经存在epub命名空间
    if (!htmlTag.includes("xmlns:epub")) {
      // 如果不存在，则添加epub命名空间
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
  // 使用正则表达式匹配 <p> 标签中的 align 属性
  const regex = /(<p\b[^>]*?\s)align=["']center["']([^>]*>)/gi;

  // 将匹配到的 align 属性替换为 style="text-align: center;"
  return html.replace(regex, '$1style="text-align: center;"$2');
}

// 用于将单个Markdown文件转换为HTML
async function convertMarkdownToHtmlPandoc(inputPath, outputPath) {
  try {
    await execAsync(
      `pandoc "${inputPath}" -f markdown -t html5 -s -o "${outputPath}"`
    );

    // 读取生成的 HTML 文件
    let htmlContent = await fs.promises.readFile(outputPath, "utf-8");

    // 添加 EPUB 命名空间声明
    // xmlns:epub="http://www.idpf.org/2007/ops"
    htmlContent = addEpubNamespaceToHtml(htmlContent);

    // 将 <p align="center"> 标签替换为 <p style="text-align: center;">
    htmlContent = replaceAlign(htmlContent);

    // 将修改后的内容写回文件
    await fs.promises.writeFile(outputPath, htmlContent, "utf-8");
  } catch (error) {
    console.error(
      `Error converting markdown to HTML: ${inputPath}. Error: ${error}`
    );
    // 生成一个包含错误信息的默认HTML
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

async function downloadImage(url, dest) {
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    const contentType = response.headers["content-type"];
    let fileExtension = "";

    if (contentType) {
      // 根据 Content-Type 推断文件后缀
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
        // 添加其他图片类型的判断...
        default:
          fileExtension = ".jpg"; // 默认使用 .jpg 作为后缀
      }
    } else {
      console.warn(
        `无法获取图片的 Content-Type: ${url}. 使用默认的 .jpg 后缀.`
      );
      fileExtension = ".jpg";
    }

    // 确保目标路径包含正确的文件后缀
    const destWithExtension = dest.endsWith(fileExtension)
      ? dest
      : dest + fileExtension;

    const writer = fs.createWriteStream(destWithExtension);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error(`图片下载失败: ${url}. Error: ${error.message}`);
    throw error;
  }
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
  coverImagePath,
  resourcePaths,
  uuid
) {
  let manifestItems = "";
  let spineItems = "";

  // 为每个HTML文件创建manifest项
  htmlFiles.forEach((file, index) => {
    const id = `item${index + 1}`;
    const href = `${file}`; // 确保引用的路径是正确的
    manifestItems += `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>\n`;
    spineItems += `<itemref idref="${id}"/>\n`;
  });

  // 如果存在封面图像，添加到manifest
  if (coverImagePath) {
    const coverImageName = path.basename(coverImagePath);
    manifestItems += `<item id="cover-image" href="images/${coverImageName}" media-type="image/jpeg" properties="cover-image"/>\n`;
  }

  // 添加OEBPS/images目录中的所有图片到manifest
  const imagesDir = "OEBPS/images";
  if (fs.existsSync(imagesDir)) {
    const imageFiles = fs.readdirSync(imagesDir);
    imageFiles.forEach((file, index) => {
      const mediaType = getMediaType(file);
      manifestItems += `<item id="image${
        index + 1
      }" href="images/${file}" media-type="${mediaType}"/>\n`;
    });
  }

  // 添加其他资源到manifest
  resourcePaths.forEach((resourcePath, index) => {
    const resourceName = path.basename(resourcePath);
    const mediaType = getMediaType(resourcePath); // 根据文件扩展名获取正确的媒体类型
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

// 根据文件扩展名获取媒体类型
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
    // 添加其他常见的媒体类型
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

  // 假设titles数组包含了与htmlFiles对应的章节标题
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
  // 添加mimetype文件
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  // 添加container.xml文件
  // 创建EPUB必要的文件夹结构
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

async function processImageReferences(
  zip,
  markdownDir,
  epubDir,
  markdownFilePath
) {
  const markdownContent = await fs.promises.readFile(markdownFilePath, "utf-8");

  // 匹配markdown图片语法
  const markdownImagePattern = /!\[[^\]]*\]\((.*?)\)/g;
  const markdownImageMatches = markdownContent.match(markdownImagePattern);

  // 匹配直接URL图片语法
  const urlImagePattern = /\[(http[^[\]]+)\]/g;
  const urlImageMatches = markdownContent.match(urlImagePattern);

  // 合并两种类型的匹配结果
  const matches = [...(markdownImageMatches || []), ...(urlImageMatches || [])];

  if (matches) {
    const epubBaseDir = "OEBPS";
    for (const match of matches) {
      let imagePath;
      let isUrlImage = false;

      // 根据匹配的类型提取图片URL
      if (match.startsWith("![")) {
        imagePath = match.match(/\((.*?)\)/)[1];
      } else {
        imagePath = match.slice(1, -1);
        isUrlImage = true;
      }

      if (imagePath.startsWith("http")) {
        const imageName = path.basename(imagePath);
        const fileExtension = path.extname(imageName);

        let imageDestPath;
        if (fileExtension) {
          imageDestPath = path.join(epubBaseDir, "images", imageName);
        } else {
          const tempImageName = `temp_${Date.now()}`;
          imageDestPath = path.join(epubBaseDir, "images", tempImageName);
        }

        try {
          const response = await axios.head(imagePath);
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
              default:
                fileExtension = ".jpg";
            }
          } else {
            console.warn(
              `无法获取图片的 Content-Type: ${imagePath}. 使用默认的 .jpg 后缀.`
            );
            fileExtension = ".jpg";
          }

          const realImageName = `${path.basename(
            imageDestPath
          )}${fileExtension}`;
          const realImageDestPath = path.join(
            epubBaseDir,
            "images",
            realImageName
          );

          await downloadImage(imagePath, realImageDestPath);
          console.log(`下载图片成功: ${imagePath} -> ${realImageDestPath}`);
          zip.file(realImageDestPath, fs.readFileSync(realImageDestPath));

          const localImagePath = path.join("images", realImageName);
          if (isUrlImage) {
            // 如果是直接URL图片,替换整个匹配
            markdownContent = markdownContent.replace(match, localImagePath);
          } else {
            // 如果是markdown图片,只替换URL部分
            markdownContent = markdownContent.replace(
              imagePath,
              localImagePath
            );
          }
        } catch (err) {
          console.error(`下载图片失败: ${imagePath}. 使用占位符替换.`);
          const placeholderImage = "images/placeholder.svg";
          if (isUrlImage) {
            markdownContent = markdownContent.replace(match, placeholderImage);
          } else {
            markdownContent = markdownContent.replace(
              imagePath,
              placeholderImage
            );
          }
        }
      } else {
        const normalizedImagePath = path.normalize(imagePath);
        const absoluteImagePath = path.join(markdownDir, normalizedImagePath);

        // 检查本地图片是否存在
        if (fs.existsSync(absoluteImagePath)) {
          const imageDestPath = path.join(
            epubBaseDir,
            "images",
            path.basename(normalizedImagePath)
          );

          await fs.promises.mkdir(path.dirname(imageDestPath), {
            recursive: true,
          });
          await fs.promises.copyFile(absoluteImagePath, imageDestPath);
          console.log(
            `复制本地图片: ${normalizedImagePath} -> ${imageDestPath}`
          );
          zip.file(imageDestPath, fs.readFileSync(absoluteImagePath));

          // 更新markdown内容中的图片引用为EPUB内部路径
          const epubImagePath = path
            .join("images", path.basename(normalizedImagePath))
            .replace(/\\/g, "/");
          markdownContent = markdownContent.replace(imagePath, epubImagePath);
        } else {
          console.warn(`本地图片不存在: ${absoluteImagePath}. 使用占位符替换.`);
          // 使用占位符图片替换原始图片引用
          const placeholderImage = "images/placeholder.svg";
          markdownContent = markdownContent.replace(
            imagePath,
            placeholderImage
          );
        }
      }
    }

    // 将更新后的markdown内容写回文件
    await fs.promises.writeFile(markdownFilePath, markdownContent, "utf-8");
  }
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

  // 生成占位符图片
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

      // 处理 Markdown 文件中的图片引用
      await processImageReferences(zip, markdownDir, epubDir, filePath);

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

    await addCoverAndResources(zip, coverImagePath, resourcePaths);

    console.log("生成content.opf...");
    const uuid = uuidv4();
    const contentOpf = generateContentOpf(
      metadata,
      htmlFiles,
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
const markdownDir = "markdown/rolldown"; // 替换为实际的Markdown文件夹路径
const epubPath = "output.epub";
const metadata = {
  title: "电子书标题",
  author: "作者",
};

// const coverImagePath = "cover.jpg"; // 封面图片路径
// const resourcePaths = ["OEBPS/images"]; // 资源文件路径

createEpub(
  markdownDir,
  epubPath,
  metadata
  // coverImagePath,
  // resourcePaths
).catch(console.error);

async function createEpubFromMarkdown(
  markdownFiles,
  epubOutputPath,
  metadata,
  titles,
  coverImagePath,
  resourcePaths
) {
  const zip = new JSZip();
  initializeEpubStructure(zip);

  const htmlFiles = [];
  await cleanDirectory("OEBPS");
  await ensureDirectoryExists("OEBPS");
  for (const file of markdownFiles) {
    const htmlFilename = path.basename(file, ".md") + ".html";
    await convertMarkdownToHtmlPandoc(file, `OEBPS/${htmlFilename}`);
    const content = await fs.promises.readFile(
      `OEBPS/${htmlFilename}`,
      "utf-8"
    );
    zip.file(`OEBPS/${htmlFilename}`, content); // 确保文件路径正确
    htmlFiles.push(htmlFilename); // 修改这里以确保路径正确
  }

  await addCoverAndResources(zip, coverImagePath, resourcePaths);

  const uuid = uuidv4(); // 生成一个 UUID

  const contentOpf = generateContentOpf(
    metadata,
    htmlFiles,
    coverImagePath,
    resourcePaths,
    uuid // 将 UUID 传递给 generateContentOpf 函数
  );
  zip.file("OEBPS/content.opf", contentOpf);

  const tocXhtml = generateTocXhtml(htmlFiles, titles);
  zip.file("OEBPS/toc.xhtml", tocXhtml);

  const tocNcx = generateTocNcx(htmlFiles, titles, uuid);
  zip.file("OEBPS/toc.ncx", tocNcx);

  zip
    .generateAsync({ type: "nodebuffer" })
    .then(function (content) {
      fs.writeFileSync(epubOutputPath, content);
      console.log(`EPUB电子书已创建在 ${epubOutputPath}`);
    })
    .catch((error) => console.error("Failed to generate EPUB:", error));
}
