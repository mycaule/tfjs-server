const express = require('express')
const compression = require('compression')
const multer = require('multer')
const fetch = require('node-fetch')
const ash = require('express-async-handler')

const sharp = require('sharp')
const jpeg = require('jpeg-js')

const tf = require('@tensorflow/tfjs-node') // tfjs-node-gpu
// -gpu but MacOS doesn't support it
// https://www.google.com/search?q=intel+gpu+tensorflow+mac+book+pro

const port = 3030

// Check https://github.com/lovell/sharp/blob/master/docs/api-resize.md
const resize = (buffer, format = 'jpg', width = 500, height = 500, fit = 'inside') =>
  sharp(buffer).toFormat(format).resize({ width, height, fit })

const getTensor3d = async (img, info) => {
  const image = await jpeg.decode(img, true) // FIXME This is artificial

  const numChannels = info.channels
  const numPixels = info.width * info.height
  const values = new Int32Array(numPixels * numChannels)

  for (let i = 0; i < numPixels; i++)
    for (let c = 0; c < numChannels; ++c)
      values[i * numChannels + c] = image.data[i * 4 + c]

  return tf.tensor3d(values, [info.height, info.width, info.channels], 'int32')
}

const server = express()
const upload = multer()

const prepare = async (buffer) => {
  const { data, info } = await resize(buffer).toBuffer({ resolveWithObject: true })
  return getTensor3d(data, info)
}

// Singleton containing all the tfjs models
let _models

const start_models = async () => {
  // Downloads some files from tfhub.dev and loads into memory
  const toxicity = await require('@tensorflow-models/toxicity').load(0.9)
  const mobilenet = await require('@tensorflow-models/mobilenet').load({ version: 2, alpha: 1.0 })
  const cocossd = await require('@tensorflow-models/coco-ssd').load()
  const use = await require('@tensorflow-models/universal-sentence-encoder').load()
  const tesseract = await require('tesseract.js').createWorker()
  await tesseract.load()
  await tesseract.loadLanguage('eng')
  await tesseract.initialize('eng')

  const faceapi = require('face-api.js')

  await faceapi.nets.ssdMobilenetv1.loadFromDisk('./faceapi/weights')
  await faceapi.nets.ageGenderNet.loadFromDisk('./faceapi/weights')
  const colorthief = await require('colorthief')

  _models = { toxicity, mobilenet, cocossd, faceapi, tesseract, colorthief, use }

  // TODO Timeout strategy if something failed
  // Log loading time + model size
  // TODO Error messages when the models are unavailable at inference time
  return true
}

server.use(compression())
// Face API
server.get('/v2/faceapi', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const resp = await fetch(req.query.image_url)
    const buffer = await resp.buffer()
    const image = await prepare(buffer)
    const faceDetectionOptions = new _models.faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
    const prediction = await _models.faceapi.detectAllFaces(image, faceDetectionOptions)
      .withAgeAndGender()

    res.json(prediction)
  }
}))

// Image Tags
server.get('/v2/mobilenet', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const resp = await fetch(req.query.image_url)
    const buffer = await resp.buffer()
    const image = await prepare(buffer)
    const prediction = await _models.mobilenet.classify(image, 5)

    res.json(prediction)
  }
}))

server.post('/v2/mobilenet', upload.single("image"), ash(async (req, res) => {
  if (!req.file)
    res.status(400).send("Missing image multipart/form-data")
  else {
    const image = await prepare(req.file.buffer)
    const prediction = await _models.mobilenet.classify(image, 5)
    res.json(prediction)
  }
}))

// Object detection
server.get('/v2/cocossd', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const resp = await fetch(req.query.image_url)
    const buffer = await resp.buffer()
    const image = await prepare(buffer)
    const prediction = await _models.cocossd.detect(image)
    res.json(prediction)
  }
}))

server.post('/v2/cocossd', upload.single("image"), ash(async (req, res) => {
  if (!req.file)
    res.status(400).send("Missing image multipart/form-data")
  else {
    const image = await prepare(req.file.buffer)
    const prediction = await _models.cocossd.detect(image)
    res.json(prediction)
  }
}))

// Text Extraction
server.get('/v2/tesseract', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const { data: { text } } = await _models.tesseract.recognize(req.query.image_url)
    // TODO Optimizations here: https://github.com/naptha/tesseract.js/blob/master/docs/examples.md
    res.json({ text })
  }
}))

// Color Extraction
server.get('/v2/colorthief', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const palette = await _models.colorthief.getPalette(req.query.image_url, 5)
    res.json({ palette: palette.map(x => "#" + x.map(y => y.toString(16)).join("")) })
  }
}))

// Toxicity
server.get('/v2/toxicity', ash(async (req, res) => {
  if (!req.query.message)
    res.status(400).send("Missing message parameter")
  else {
    const message = req.query.message
    const lang = req.query.lang
    if (lang == 'fr')
      res.status(500).send(`lang=${lang} is not supported yet`)
    else {
      const prediction = await _models.toxicity.classify(message)
      res.json(prediction)
    }
  }
}))

// TODO POST route

// Debug, Resize
server.get('/v2/resize', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const width = req.query.width ? parseInt(req.query.width) : undefined
    const height = req.query.height ? parseInt(req.query.width) : undefined
    const fit = req.query.fit ? req.query.fit : undefined

    const resp = await fetch(req.query.image_url)
    const buffer = await resp.buffer()
    resize(buffer, 'jpg', width, height, fit).pipe(res)
  }
}))

// Debug, Embeddings Image
server.get('/v2/embeddings/mobilenet', ash(async (req, res) => {
  if (!req.query.image_url)
    res.status(400).send("Missing image_url parameter")
  else {
    const resp = await fetch(req.query.image_url)
    const buffer = await resp.buffer()
    const image = await prepare(buffer)
    const embeddings = await _models.mobilenet.infer(image, true)
    const prediction = await embeddings.array()
    res.json(prediction)
  }
}))

// Debug, Embeddings Text
server.get('/v2/embeddings/use', ash(async (req, res) => {
  if (!req.query.message)
    res.status(400).send("Missing message parameter")
  else {
    // TODO use body to input several sentences
    const sentences = [req.query.message]
    const embeddings = await _models.use.embed(sentences)
    const prediction = await embeddings.array()
    res.json(prediction)
  }
}))

// Load the models and start the webserver
start_models().then((result) => {
  console.log('🤡 🤡 Successfully loaded the models 🤡 🤡')

  server.listen(port, () => {
    console.log(`Server is listening on ${port}`)
  })
})
