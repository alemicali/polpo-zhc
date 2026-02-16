import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class QualificationsRecord extends FirestoreRecord {
  QualificationsRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('qualifications');

  static Stream<QualificationsRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => QualificationsRecord.fromSnapshot(s));

  static Future<QualificationsRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => QualificationsRecord.fromSnapshot(s));

  static QualificationsRecord fromSnapshot(DocumentSnapshot snapshot) =>
      QualificationsRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static QualificationsRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      QualificationsRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'QualificationsRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is QualificationsRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createQualificationsRecordData({
  String? name,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
    }.withoutNulls,
  );

  return firestoreData;
}

class QualificationsRecordDocumentEquality
    implements Equality<QualificationsRecord> {
  const QualificationsRecordDocumentEquality();

  @override
  bool equals(QualificationsRecord? e1, QualificationsRecord? e2) {
    return e1?.name == e2?.name;
  }

  @override
  int hash(QualificationsRecord? e) => const ListEquality().hash([e?.name]);

  @override
  bool isValidKey(Object? o) => o is QualificationsRecord;
}
