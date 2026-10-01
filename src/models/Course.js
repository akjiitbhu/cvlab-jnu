'use strict';

const { Schema, model } = require('mongoose');

/** One unit of a syllabus. */
const UnitSchema = new Schema(
  {
    _id: false,
    label: { type: String, trim: true, default: '', maxlength: 40 }, // "Unit I"
    title: { type: String, trim: true, default: '', maxlength: 200 },
    topics: { type: String, trim: true, default: '', maxlength: 1500 },
  },
  { _id: false }
);

/**
 * One row of the course-materials table.
 *
 * A row can point at a file uploaded through the editor, or at an external
 * link, or at neither. The page prefers the uploaded file when both are set,
 * and shows "link pending" when neither is — which is the honest state for a
 * material that has not been prepared yet.
 */
const ResourceSchema = new Schema(
  {
    _id: false,
    kind: { type: String, trim: true, default: '', maxlength: 40 }, // Slides, Lab, Code
    item: { type: String, trim: true, default: '', maxlength: 400 },

    // An external link (Drive, an institutional store, a dataset homepage).
    url: { type: String, trim: true, default: '', maxlength: 500 },

    // "/api/files/<id>" for a file uploaded through the editor, plus enough
    // metadata to label the download without fetching the file itself.
    fileUrl: { type: String, trim: true, default: '', maxlength: 500 },
    fileName: { type: String, trim: true, default: '', maxlength: 200 },
    fileBytes: { type: Number, default: null },
  },
  { _id: false }
);

const CourseSchema = new Schema(
  {
    // Short key used in the page's URL fragment: "cp", "ds", "dbms", "dip".
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9-]{1,40}$/, 'slug may contain only a-z, 0-9 and hyphens'],
    },

    title: { type: String, required: true, trim: true, maxlength: 200 },

    // "Engg Foundation-I"
    designation: { type: String, trim: true, default: '', maxlength: 120 },

    semester: {
      type: String,
      trim: true,
      default: '',
      enum: ['', 'Monsoon', 'Winter', 'Both'],
    },

    // "B.Tech. 1st year"
    level: { type: String, trim: true, default: '', maxlength: 120 },

    // "3-0-2"
    ltp: { type: String, trim: true, default: '', maxlength: 40 },

    // Shown as a chip; distinguishes core courses from electives.
    category: {
      type: String,
      trim: true,
      default: 'Core',
      enum: ['Core', 'Elective', 'Lab', 'Other'],
    },

    description: { type: String, trim: true, default: '', maxlength: 1500 },

    units: [UnitSchema],
    resources: [ResourceSchema],

    // One reference per line, rendered as a list.
    reading: { type: String, trim: true, default: '', maxlength: 3000 },

    // Set false for a course no longer taught; it moves to a quieter group.
    current: { type: Boolean, default: true },

    order: { type: Number, default: 0, index: true },
    visible: { type: Boolean, default: true },
  },
  { timestamps: true }
);

CourseSchema.index({ order: 1, title: 1 });

module.exports = model('Course', CourseSchema);
