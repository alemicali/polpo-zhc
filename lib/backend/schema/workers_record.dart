import 'dart:async';

import 'package:collection/collection.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class WorkersRecord extends FirestoreRecord {
  WorkersRecord._(
    DocumentReference reference,
    Map<String, dynamic> data,
  ) : super(reference, data) {
    _initializeFields();
  }

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  bool hasName() => _name != null;

  // "active" field.
  bool? _active;
  bool get active => _active ?? false;
  bool hasActive() => _active != null;

  // "qualifications" field.
  List<DocumentReference>? _qualifications;
  List<DocumentReference> get qualifications => _qualifications ?? const [];
  bool hasQualifications() => _qualifications != null;

  // "user" field.
  DocumentReference? _user;
  DocumentReference? get user => _user;
  bool hasUser() => _user != null;

  // "accomodations" field.
  List<DocumentReference>? _accomodations;
  List<DocumentReference> get accomodations => _accomodations ?? const [];
  bool hasAccomodations() => _accomodations != null;

  // "supervisor" field.
  bool? _supervisor;
  bool get supervisor => _supervisor ?? false;
  bool hasSupervisor() => _supervisor != null;

  void _initializeFields() {
    _name = snapshotData['name'] as String?;
    _active = snapshotData['active'] as bool?;
    _qualifications = getDataList(snapshotData['qualifications']);
    _user = snapshotData['user'] as DocumentReference?;
    _accomodations = getDataList(snapshotData['accomodations']);
    _supervisor = snapshotData['supervisor'] as bool?;
  }

  static CollectionReference get collection =>
      FirebaseFirestore.instance.collection('workers');

  static Stream<WorkersRecord> getDocument(DocumentReference ref) =>
      ref.snapshots().map((s) => WorkersRecord.fromSnapshot(s));

  static Future<WorkersRecord> getDocumentOnce(DocumentReference ref) =>
      ref.get().then((s) => WorkersRecord.fromSnapshot(s));

  static WorkersRecord fromSnapshot(DocumentSnapshot snapshot) =>
      WorkersRecord._(
        snapshot.reference,
        mapFromFirestore(snapshot.data() as Map<String, dynamic>),
      );

  static WorkersRecord getDocumentFromData(
    Map<String, dynamic> data,
    DocumentReference reference,
  ) =>
      WorkersRecord._(reference, mapFromFirestore(data));

  @override
  String toString() =>
      'WorkersRecord(reference: ${reference.path}, data: $snapshotData)';

  @override
  int get hashCode => reference.path.hashCode;

  @override
  bool operator ==(other) =>
      other is WorkersRecord &&
      reference.path.hashCode == other.reference.path.hashCode;
}

Map<String, dynamic> createWorkersRecordData({
  String? name,
  bool? active,
  DocumentReference? user,
  bool? supervisor,
}) {
  final firestoreData = mapToFirestore(
    <String, dynamic>{
      'name': name,
      'active': active,
      'user': user,
      'supervisor': supervisor,
    }.withoutNulls,
  );

  return firestoreData;
}

class WorkersRecordDocumentEquality implements Equality<WorkersRecord> {
  const WorkersRecordDocumentEquality();

  @override
  bool equals(WorkersRecord? e1, WorkersRecord? e2) {
    const listEquality = ListEquality();
    return e1?.name == e2?.name &&
        e1?.active == e2?.active &&
        listEquality.equals(e1?.qualifications, e2?.qualifications) &&
        e1?.user == e2?.user &&
        listEquality.equals(e1?.accomodations, e2?.accomodations) &&
        e1?.supervisor == e2?.supervisor;
  }

  @override
  int hash(WorkersRecord? e) => const ListEquality().hash([
        e?.name,
        e?.active,
        e?.qualifications,
        e?.user,
        e?.accomodations,
        e?.supervisor
      ]);

  @override
  bool isValidKey(Object? o) => o is WorkersRecord;
}
