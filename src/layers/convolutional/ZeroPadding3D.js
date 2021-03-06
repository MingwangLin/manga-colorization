import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import ops from 'ndarray-ops'
import mapInputProgramSource from '../../webgl/mapInput.glsl'

/**
 * ZeroPadding3D layer class
 */
export default class ZeroPadding3D extends Layer {
  /**
   * Creates a ZeroPadding3D layer
   *
   * @param {Object} [attrs] - layer config attributes
   * @param {number|number[]|number[][]} [attrs.padding] - int, or tuple of 2 ints, or tuple of 2 tuples of 2 ints
   * @param {string} [attrs.data_format] - either 'channels_last' or 'channels_first'
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'ZeroPadding3D'

    const { padding = [[1, 1], [1, 1], [1, 1]], data_format = 'channels_last' } = attrs

    if (Array.isArray(padding)) {
      if (Array.isArray(padding[0])) {
        // [[int, int], [int, int], [int, int]]
        this.padding = padding
      } else {
        // [int, int, int]
        this.padding = [[padding[0], padding[0]], [padding[1], padding[1]], [padding[2], padding[2]]]
      }
    } else {
      // int
      this.padding = [[padding, padding], [padding, padding], [padding, padding]]
    }

    this.dataFormat = data_format

    this.description = `${JSON.stringify(this.padding)}`

    // GPU setup
    if (this.gpu) {
      this.mapInputProgram = webgl2.compileProgram(mapInputProgramSource)
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    // convert to channels_last ordering if necessary
    if (this.dataFormat === 'channels_first') {
      x.tensor = x.tensor.transpose(1, 2, 3, 0)
    }

    this.inputShape = x.tensor.shape
    this.outputShape = [
      this.inputShape[0] + this.padding[0][0] + this.padding[0][1],
      this.inputShape[1] + this.padding[1][0] + this.padding[1][1],
      this.inputShape[2] + this.padding[2][0] + this.padding[2][1],
      this.inputShape[3]
    ]
    this.output = new Tensor([], this.outputShape)
    ops.assign(
      this.output.tensor
        .hi(
          this.inputShape[0] + this.padding[0][0],
          this.inputShape[1] + this.padding[1][0],
          this.inputShape[2] + this.padding[2][0],
          this.inputShape[3]
        )
        .lo(this.padding[0][0], this.padding[1][0], this.padding[2][0], 0),
      x.tensor
    )

    // convert back to channels_first ordering if necessary
    if (this.dataFormat === 'channels_first') {
      x.tensor = x.tensor.transpose(3, 0, 1, 2)
      this.output.tensor = this.output.tensor.transpose(3, 0, 1, 2)
    }
  }

  /**
   * Creates row/col index mappings to map input texture to output texture
   *
   * @param {Object} indicesForReshaped
   * @param {boolean} is2DReshaped
   */
  _createIndexMap(indicesForReshaped, is2DReshaped) {
    if (this.indexMap) {
      return
    }

    const indices = new Tensor(indicesForReshaped.data, indicesForReshaped.shape, { type: Int32Array })

    this.indexMap = new Tensor([], this.outputShape, { type: Int32Array })

    const sliceStart =
      this.dataFormat === 'channels_first'
        ? [0, this.padding[0][0], this.padding[1][0], this.padding[2][0]]
        : [this.padding[0][0], this.padding[1][0], this.padding[2][0], 0]
    const sliceEnd =
      this.dataFormat === 'channels_first'
        ? [
            this.inputShape[0],
            this.inputShape[1] + this.padding[0][0],
            this.inputShape[2] + this.padding[1][0],
            this.inputShape[3] + this.padding[2][0]
          ]
        : [
            this.inputShape[0] + this.padding[0][0],
            this.inputShape[1] + this.padding[1][0],
            this.inputShape[2] + this.padding[2][0],
            this.inputShape[3]
          ]

    ops.assigns(this.indexMap.tensor, -1)
    ops.assign(this.indexMap.tensor.hi(...sliceEnd).lo(...sliceStart), indices.tensor)

    if (is2DReshaped) {
      this.indexMap.reshapeTo2D()
    } else {
      this.indexMap.reshapeTo2DSquare()
    }
    this.indexMap.createGLTexture({ type: '2d', format: 'int' })
  }

  /**
   * GPU call
   *
   * @param {Tensor} x
   */
  _callGPU(x) {
    if (!x.glTexture) {
      // defaults to square reshaped
      x.reshapeTo2DSquare()
      x.createGLTexture({ type: '2d', format: 'float' })
    }
    this.inputShape = x.originalShape
    this.outputShape =
      this.dataFormat === 'channels_first'
        ? [
            this.inputShape[0],
            this.inputShape[1] + this.padding[0][0] + this.padding[0][1],
            this.inputShape[2] + this.padding[1][0] + this.padding[1][1],
            this.inputShape[3] + this.padding[2][0] + this.padding[2][1]
          ]
        : [
            this.inputShape[0] + this.padding[0][0] + this.padding[0][1],
            this.inputShape[1] + this.padding[1][0] + this.padding[1][1],
            this.inputShape[2] + this.padding[2][0] + this.padding[2][1],
            this.inputShape[3]
          ]

    this._createIndexMap(x.indicesForReshaped, x.is2DReshaped)

    if (!this.output) {
      this.output = new Tensor([], this.outputShape)
      if (x.is2DReshaped) {
        this.output.reshapeTo2D()
      } else {
        this.output.reshapeTo2DSquare()
      }
      this.output.createGLTexture({ type: '2d', format: 'float' })
    }

    webgl2.runProgram({
      program: this.mapInputProgram,
      output: this.output,
      inputs: [{ input: x, name: 'x' }, { input: this.indexMap, name: 'indexMap' }],
      uniforms: [{ value: x.glTextureShape[1], type: 'int', name: 'inputCols' }]
    })

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      if (this.output.is2DReshaped) {
        this.output.reshapeFrom2D()
      } else {
        this.output.reshapeFrom2DSquare()
      }
    }
  }
}
