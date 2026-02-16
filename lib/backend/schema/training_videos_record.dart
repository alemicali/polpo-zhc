import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class TrainingVideosRecord extends FirestoreRecord {
  TrainingVideosRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "title" field.
  String? _title;
  String get title => _title ?? '';
  bool hasTitle() => _title != null;

  // "description" field.
  String? _description;
  String get description => _description ?? '';
  bool hasDescription() => _description != null;

  // "active" field.
  bool? _active;
  bool get active => _active ?? false;
  bool hasActive() => _active != null;

  // "order" field.
  int? _order;
  int get order => _order ?? 0;
  bool hasOrder() => _order != null;

  // "video_url" field.
  String? _videoUrl;
  String get videoUrl => _videoUrl ?? '';
  bool hasVideoUrl() => _videoUrl != null;

  void _initializeFields() {
    _title = snapshotData['title'] as String?;
    _description = snapshotData['description'] as String?;
    _active = snapshotData['active'] as bool?;
    _order = castToType<int>(snapshotData['order']);
    _videoUrl = snapshotData['video_url'] as String?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('training_videos');

  static Stream<TrainingVideosRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => TrainingVideosRecord.fromSnapshot(s));

  static Future<TrainingVideosRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => TrainingVideosRecord.fromSnapshot(s));

  static TrainingVideosRecord fromSnapshot(DocumentSnapshot snapshot) =>
      TrainingVideosRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static TrainingVideosRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      TrainingVideosRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'TrainingVideosRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is TrainingVideosRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createTrainingVideosRecordData({
  String? title,
  String? description,
  bool? active,
  int? order,
  String? videoUrl,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'title': title,
      'description': description,
      'active': active,
      'order': order,
      'video_url': videoUrl,
    }.withoutNulls,
  );

  return firestoreData;
}

class TrainingVideosRecordDocumentEquality
    implements Equality<TrainingVideosRecord> {
  const TrainingVideosRecordDocumentEquality();

  @override
  bool equals(TrainingVideosRecord? e1, TrainingVideosRecord? e2) {
    return e1?.title == e2?.title &&
        e1?.description == e2?.description &&
        e1?.active == e2?.active &&
        e1?.order == e2?.order &&
        e1?.videoUrl == e2?.videoUrl;
  }

  @override
  int hash(TrainingVideosRecord? e) => const ListEquality()
      .hash([e?.title, e?.description, e?.active, e?.order, e?.videoUrl]);

  @override
  bool isValidKey(Object? o) => o is TrainingVideosRecord;
}
